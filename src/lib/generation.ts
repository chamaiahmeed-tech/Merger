import { randomUUID } from "node:crypto";
import { getTask, insertTask, updateTask, parseUrls, safeParse, type TaskRow } from "./turso";
import { classifyProviderError, getKeyPool, getKeyById, recordKeyAttempt, type ErrorClass, type KeyRow } from "./keys";
import { getAdapter } from "./providers";
import { ProviderError } from "./providers/types";
import { MODELS, resolveModel, type ModelDef, type MediaType, type ProviderId } from "./models";

// ====== منسّق التوليد (قسم 6) + صياغة الردود العربية ======

export interface ToolReply {
  text: string;
  isError?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function processingReply(taskId: string, progress?: number): ToolReply {
  let text = `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
  if (progress && progress > 0) text += `\n\nالتقدم الحالي: ${progress}%`;
  return { text };
}

export function completedReply(type: MediaType, urls: string[]): ToolReply {
  if (type === "image") {
    return { text: `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}` };
  }
  if (type === "video") {
    return { text: `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${urls.join("\nالرابط المباشر: ")}` };
  }
  return {
    text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
  };
}

export function failedReply(reason: string): ToolReply {
  return { text: `❌ فشلت المهمة: ${reason}`, isError: true };
}

export function noKeysReply(model: string): ToolReply {
  return {
    text: `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    isError: true,
  };
}

export async function completeTask(taskId: string, urls: string[]): Promise<void> {
  await updateTask(taskId, {
    status: "completed",
    progress: 100,
    result_urls_json: JSON.stringify(urls),
    error_message: null,
  });
}

interface Created {
  key: KeyRow;
  provider: ProviderId;
  providerTaskId?: string;
  urls?: string[];
  index: number;
}

// محاولة واحدة عبر مرشّح واحد — تسجّل المحاولة وعدّادات المفتاح دائمًا
async function attemptCandidate(
  taskId: string,
  def: ModelDef,
  input: Record<string, unknown>,
  key: KeyRow,
  index: number
): Promise<{ ok: true; created: Created } | { ok: false; cls: ErrorClass; error: string }> {
  const adapter = getAdapter(key.provider);
  let outcome: { ok: true; created: Created } | { ok: false; cls: ErrorClass; error: string };
  try {
    if (def.type === "image" && adapter.createImageSync) {
      const r = await adapter.createImageSync(key.api_key, def.providerModel[key.provider], input);
      outcome = { ok: true, created: { key, provider: key.provider, urls: r.urls, index } };
    } else {
      const r = await adapter.createTask(key.api_key, def.providerModel[key.provider], input);
      outcome = { ok: true, created: { key, provider: key.provider, providerTaskId: r.providerTaskId, index } };
    }
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    outcome = { ok: false, cls: classifyProviderError(status as number | undefined, message), error: message };
  }
  await recordKeyAttempt(taskId, key, outcome.ok, outcome.ok ? undefined : { cls: outcome.cls, error: outcome.error });
  return outcome;
}

type CreateOnPoolResult =
  | { ok: true; created: Created; paramsFailed?: undefined }
  | { ok: false; created?: undefined; paramsFailed?: string };

// التمر على المرشحين بالترتيب التسلسلي الصارم بدءًا من startIndex حتى أول نجاح.
// السلوك «لا توقف أبدًا»: disabled/exhausted/provider/temporary → المفتاح التالي فورًا؛
// params فقط → توقف فوري (تبديل المفاتيح لن يحل خطأ معطيات).
async function createOnPool(
  taskId: string,
  def: ModelDef,
  input: Record<string, unknown>,
  pool: KeyRow[],
  startIndex: number
): Promise<CreateOnPoolResult> {
  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const r = await attemptCandidate(taskId, def, input, pool[i], i);
    if (r.ok) return r;
    if (r.cls === "params") {
      await updateTask(taskId, { status: "failed", error_message: r.error });
      return { ok: false, paramsFailed: r.error };
    }
  }
  return { ok: false };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (أو نفسه إن كان الخطأ مؤقتًا)
async function recreate(
  taskId: string,
  def: ModelDef,
  input: Record<string, unknown>,
  pool: KeyRow[],
  current: Created,
  cls: ErrorClass,
  reCreations: number
): Promise<{ created?: Created; count: number }> {
  if (reCreations >= 4) return { count: reCreations };
  const startIndex = cls === "temporary" ? current.index : current.index + 1;
  if (startIndex >= pool.length) return { count: reCreations };
  const re = await createOnPool(taskId, def, input, pool, startIndex);
  if (!re.ok) return { count: reCreations + 1 };
  return { created: re.created, count: reCreations + 1 };
}

function linkTask(taskId: string, c: Created): Promise<void> {
  return updateTask(taskId, {
    provider: c.provider,
    key_id: c.key.id,
    provider_task_id: c.providerTaskId ?? null,
    status: "processing",
    progress: 8,
  });
}

export interface RunGenerationArgs {
  type: "image" | "video";
  def: ModelDef;
  input: Record<string, unknown>;
  prompt: string;
  waitSeconds: number;
  notify?: (progress: number, message: string) => void | Promise<void>;
}

export async function runGeneration(args: RunGenerationArgs): Promise<ToolReply> {
  // 1) مجموعة المفاتيح بالترتيب الصارم
  const pool = await getKeyPool(args.def.providers);
  if (!pool.length) return noKeysReply(args.def.canonical);
  // 2) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: args.def.canonical,
    type: args.type,
    prompt: args.prompt,
    params_json: JSON.stringify({ input: args.input }),
  });
  // 3) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const first = await createOnPool(taskId, args.def, args.input, pool, 0);
  if (first.paramsFailed) return failedReply(`معطيات الطلب غير صحيحة: ${first.paramsFailed}`);
  if (!first.ok) {
    // فشل على كل المفاتيح → تبقى المهمة بلا فشل وتُعاد محاولتها تلقائيًا مع كل get_task (تهدئة ~45ث)
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
    return processingReply(taskId);
  }
  let current = first.created;
  if (current.urls) {
    // صورة متزامنة (CometAPI) — اكتملت فورًا
    await completeTask(taskId, current.urls);
    return completedReply(args.type, current.urls);
  }
  await linkTask(taskId, current);
  // 4) نافذة الانتظار (0–240ث) مع استعلام كل 3 ثوانٍ وبث تقدم حي
  const deadline = Date.now() + args.waitSeconds * 1000;
  let lastProgress = 8;
  let reCreations = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const adapter = getAdapter(current.provider);
    let check;
    try {
      check = await adapter.checkTask(current.key.api_key, current.providerTaskId!);
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const cls = classifyProviderError(status as number | undefined, message);
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: message });
        return failedReply(message);
      }
      if (cls === "temporary") continue; // مهلة/شبكة — نستمر بالاستعلام حتى نهاية النافذة
      // مفتاح مات في منتصف المهمة → أعد الإنشاء بنفس task_id على المفتاح التالي
      const re = await recreate(taskId, args.def, args.input, pool, current, cls, reCreations);
      reCreations = re.count;
      if (!re.created) {
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        return processingReply(taskId);
      }
      current = re.created;
      await linkTask(taskId, current);
      continue;
    }
    if (check.status === "completed" && check.urls?.length) {
      await completeTask(taskId, check.urls);
      return completedReply(args.type, check.urls);
    }
    if (check.status === "failed") {
      const cls = classifyProviderError(undefined, check.error || "");
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: check.error || "" });
        return failedReply(check.error || "");
      }
      // فشل مفتاح/رصيد أو مؤقت — استئناف نفس المهمة على المرشح التالي دون علم العميل
      const re = await recreate(taskId, args.def, args.input, pool, current, cls, reCreations);
      reCreations = re.count;
      if (!re.created) {
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        return processingReply(taskId);
      }
      current = re.created;
      await linkTask(taskId, current);
      continue;
    }
    // قيد المعالجة — حدّث التقدم في القاعدة وابثه
    const creep = Math.min(95, lastProgress + 3);
    lastProgress = Math.max(lastProgress, check.progress ?? 0, creep);
    await updateTask(taskId, { progress: lastProgress });
    await args.notify?.(lastProgress, `قيد التوليد… ${lastProgress}%`);
  }
  // انتهت النافذة والنتيجة لم تظهر — أعد task_id والعميل يتابع بـ get_task
  return processingReply(taskId, lastProgress);
}

// تحديث حي للمهمة عند get_task (للتوليد — الدمج في merge.ts)
export async function refreshGenerationTask(task: TaskRow): Promise<ToolReply> {
  if (task.status === "completed") {
    const urls = parseUrls(task.result_urls_json);
    return urls.length ? completedReply(task.type as MediaType, urls) : failedReply("المهمة مكتملة بلا روابط مخزنة");
  }
  if (task.status === "failed") return failedReply(task.error_message || "سبب غير معروف");

  const def = resolveModel(task.model) ?? MODELS.find((m) => m.canonical === task.model);
  if (!def) return failedReply(`موديل غير معروف: ${task.model}`);
  const pool = await getKeyPool(def.providers);
  if (!pool.length) return noKeysReply(def.canonical);
  const params = safeParse(task.params_json) as { input?: Record<string, unknown> };
  const input = params.input ?? { prompt: task.prompt };

  if (task.status === "pending") {
    // هدئة ~45 ثانية حتى لا نضغط المزودين بين محاولات get_task
    const last = Date.parse((task.updated_at || "").replace(" ", "T") + "Z") || 0;
    if (Date.now() - last < 45_000) return processingReply(task.id);
    const re = await createOnPool(task.id, def, input, pool, 0);
    if (re.paramsFailed) return failedReply(`معطيات الطلب غير صحيحة: ${re.paramsFailed}`);
    if (!re.ok) {
      await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      return processingReply(task.id);
    }
    if (re.created.urls) {
      await completeTask(task.id, re.created.urls);
      return completedReply(task.type as MediaType, re.created.urls);
    }
    await linkTask(task.id, re.created);
    return processingReply(task.id, 8);
  }

  // status = processing — تحديث من المزود مع نفس منطق التبديل
  const key = task.key_id ? await getKeyById(task.key_id) : null;
  if (!key || !task.provider || !task.provider_task_id) {
    // المفتاح حُذف أو بلا معرّف مزود — أعد الإنشاء على المجموعة
    const re = await createOnPool(task.id, def, input, pool, 0);
    if (re.ok && !re.paramsFailed) {
      if (re.created.urls) {
        await completeTask(task.id, re.created.urls);
        return completedReply(task.type as MediaType, re.created.urls);
      }
      await linkTask(task.id, re.created);
    }
    return processingReply(task.id, task.progress);
  }
  const adapter = getAdapter(task.provider);
  let check;
  try {
    check = await adapter.checkTask(key.api_key, task.provider_task_id);
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const cls = classifyProviderError(status as number | undefined, message);
    if (cls === "params") {
      await updateTask(task.id, { status: "failed", error_message: message });
      return failedReply(message);
    }
    if (cls === "temporary") return processingReply(task.id, task.progress);
    const idx = pool.findIndex((k) => k.id === key.id);
    const re = await createOnPool(task.id, def, input, pool, idx + 1);
    if (re.ok && !re.paramsFailed) {
      if (re.created.urls) {
        await completeTask(task.id, re.created.urls);
        return completedReply(task.type as MediaType, re.created.urls);
      }
      await linkTask(task.id, re.created);
    }
    return processingReply(task.id, task.progress);
  }
  if (check.status === "completed" && check.urls?.length) {
    await completeTask(task.id, check.urls);
    return completedReply(task.type as MediaType, check.urls);
  }
  if (check.status === "failed") {
    const cls = classifyProviderError(undefined, check.error || "");
    if (cls === "params") {
      await updateTask(task.id, { status: "failed", error_message: check.error || "" });
      return failedReply(check.error || "");
    }
    const idx = Math.max(0, pool.findIndex((k) => k.id === key.id));
    const startIndex = cls === "temporary" ? idx : idx + 1;
    if (startIndex < pool.length) {
      const re = await createOnPool(task.id, def, input, pool, startIndex);
      if (re.ok && !re.paramsFailed) {
        if (re.created.urls) {
          await completeTask(task.id, re.created.urls);
          return completedReply(task.type as MediaType, re.created.urls);
        }
        await linkTask(task.id, re.created);
      }
    }
    return processingReply(task.id, task.progress);
  }
  const p = Math.max(Number(task.progress) || 0, check.progress ?? 0);
  if (p !== task.progress) await updateTask(task.id, { progress: p });
  return processingReply(task.id, p);
}

export { getTask };
