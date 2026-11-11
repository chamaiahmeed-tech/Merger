import { randomUUID } from "node:crypto";
import { getTask, insertTask, updateTask, parseUrls, safeParse, type TaskRow } from "./turso";
import {
  completedReply,
  completeTask,
  failedReply,
  processingReply,
  type ToolReply,
} from "./generation";
import { classifyProviderError } from "./keys";
import { createMergeJob, getMergeJob, mergerBase, processMergeJob } from "./merger";
import { ProviderError } from "./providers/types";

// ====== تدفق runMerge وقواعده (قسم 7.3) ======

// قفل بالذاكرة يمنع تزامن نداء process مع get_task (نطاق المثيل الواحد)
const processInFlight = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunMergeArgs {
  urls: string[];
  taskIds: string[];
  waitSeconds: number;
  notify?: (progress: number, message: string) => void | Promise<void>;
}

interface PollOutcome {
  done?: boolean;
  url?: string;
  progress?: number;
  definitiveFail?: boolean;
  message?: string;
}

// استعلام حالة خدمة الدمج — قاعدة حتمية:
// أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري؛
// أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام.
async function pollMerge(jobId: string): Promise<PollOutcome> {
  try {
    const s = await getMergeJob(jobId);
    if (s.status === "done" && s.videoUrl) return { done: true, url: s.videoUrl, progress: 100 };
    if (s.status === "failed") return { definitiveFail: true, message: s.error || "فشلت خدمة الدمج" };
    return { progress: s.progress };
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404) {
      return { definitiveFail: true, message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
    }
    const cls = classifyProviderError(status as number | undefined, message);
    if (cls === "temporary") return {};
    return { definitiveFail: true, message };
  }
}

// تنفيذ POST .../process مرة واحدة فقط خلف القفل
async function runProcessOnce(taskId: string, jobId: string): Promise<{ finalFailed?: boolean; message?: string }> {
  if (processInFlight.has(jobId)) return {};
  processInFlight.add(jobId);
  try {
    await processMergeJob(jobId); // 200 done أو 202 قيد المعالجة — كلاهما مقبول
    return {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderError ? err.status : undefined;
    const cls = classifyProviderError(status as number | undefined, message);
    if (cls === "temporary") return {}; // شبكتنا نحن — مؤقتة، الاستطلاع يكمل
    // خطأ HTTP معلن (مثل Download failed) = فشل نهائي: تكرار المحاولة يعطي النتيجة نفسها
    await updateTask(taskId, { status: "failed", error_message: message });
    return { finalFailed: true, message };
  } finally {
    processInFlight.delete(jobId);
  }
}

export async function runMerge(args: RunMergeArgs): Promise<ToolReply> {
  if (!mergerBase()) {
    return { text: "❌ خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE في متغيرات البيئة.", isError: true };
  }
  // روابط task_ids المكتملة أُولًا ثم urls المباشرة بنفس ترتيبها
  const resolved: string[] = [];
  const problems: string[] = [];
  for (const id of args.taskIds) {
    const t = await getTask(id.trim());
    if (!t) {
      problems.push(`— task_id ${id}: غير موجود في قاعدة البيانات`);
      continue;
    }
    if (t.status !== "completed") {
      problems.push(`— task_id ${id}: حالتها «${t.status}» وليست completed`);
      continue;
    }
    const urls = parseUrls(t.result_urls_json);
    if (!urls.length) {
      problems.push(`— task_id ${id}: مكتملة بلا روابط نتائج`);
      continue;
    }
    resolved.push(urls[0]);
  }
  const combined = [...resolved, ...args.urls.map((u) => u.trim()).filter(Boolean)];
  // تحقق صارم: ≥2 وكلها http/https مباشرة وعامة
  if (combined.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (problems.length) text += `\n\nتفاصيل المعرفات:\n${problems.join("\n")}`;
    return { text, isError: true };
  }
  if (combined.length > 10) {
    return { text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  const bad = combined.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) {
    return { text: `❌ الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https):\n${bad.join("\n")}`, isError: true };
  }
  // سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${combined.length} مقاطع`,
    params_json: JSON.stringify({ urls: combined }),
  });
  let jobId: string;
  try {
    ({ jobId } = await createMergeJob(combined));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderError ? err.status : undefined;
    const cls = classifyProviderError(status as number | undefined, message);
    if (cls === "temporary") {
      await updateTask(taskId, { error_message: "تعذر الوصول لخدمة الدمج — بانتظار إعادة المحاولة" });
      return processingReply(taskId);
    }
    await updateTask(taskId, { status: "failed", error_message: message });
    return failedReply(message);
  }
  await updateTask(taskId, { provider: "merger", provider_task_id: jobId, status: "processing", progress: 5 });
  // أطلق process مرة واحدة فقط خلف القفل
  const proc = await runProcessOnce(taskId, jobId);
  if (proc.finalFailed) return failedReply(proc.message!);
  // نافذة الانتظار (افتراضي 60ث): استعلام كل 3 ثوانٍ مع بث تقدم وكتابة فورية في Turso
  const deadline = Date.now() + args.waitSeconds * 1000;
  let lastProgress = 5;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await pollMerge(jobId);
    if (st.definitiveFail) {
      await updateTask(taskId, { status: "failed", error_message: st.message || "" });
      return failedReply(st.message!);
    }
    if (st.done && st.url) {
      await completeTask(taskId, [st.url]);
      return completedReply("merge", [st.url]);
    }
    if (st.progress != null && st.progress > lastProgress) {
      lastProgress = st.progress;
      await updateTask(taskId, { progress: lastProgress });
      await args.notify?.(lastProgress, `جارٍ الدمج… ${lastProgress}%`);
    }
  }
  return processingReply(taskId, lastProgress);
}

// تحديث حي لمهمة دمج عند get_task
export async function refreshMergeTask(task: TaskRow): Promise<ToolReply> {
  if (task.status === "completed") {
    const urls = parseUrls(task.result_urls_json);
    return urls.length ? completedReply("merge", urls) : failedReply("المهمة مكتملة بلا روابط مخزنة");
  }
  if (task.status === "failed") return failedReply(task.error_message || "سبب غير معروف");

  if (!mergerBase()) {
    return { text: "❌ خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE في متغيرات البيئة.", isError: true };
  }

  if (task.status === "pending") {
    // فشل الإنشاء سابقًا — أعد المحاولة بعد هدئة ~45 ثانية
    const last = Date.parse((task.updated_at || "").replace(" ", "T") + "Z") || 0;
    if (Date.now() - last < 45_000) return processingReply(task.id);
    const params = safeParse(task.params_json) as { urls?: string[] };
    const urls = params.urls ?? [];
    if (urls.length < 2) {
      await updateTask(task.id, { status: "failed", error_message: "روابط الدمج أقل من مقطعين" });
      return failedReply("الدمج يحتاج مقطعين على الأقل");
    }
    try {
      const { jobId } = await createMergeJob(urls);
      await updateTask(task.id, { provider: "merger", provider_task_id: jobId, status: "processing", progress: 5 });
      const proc = await runProcessOnce(task.id, jobId);
      if (proc.finalFailed) return failedReply(proc.message!);
      return processingReply(task.id, 5);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateTask(task.id, { error_message: message });
      return processingReply(task.id);
    }
  }

  // status = processing
  const jobId = task.provider_task_id;
  if (!jobId) {
    await updateTask(task.id, { status: "failed", error_message: "مهمة بلا معرّف خدمة دمج" });
    return failedReply("مهمة بلا معرّف خدمة دمج");
  }
  const st = await pollMerge(jobId);
  if (st.definitiveFail) {
    await updateTask(task.id, { status: "failed", error_message: st.message || "" });
    return failedReply(st.message!);
  }
  if (st.done && st.url) {
    await completeTask(task.id, [st.url]);
    return completedReply("merge", [st.url]);
  }
  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن)
  const proc = await runProcessOnce(task.id, jobId);
  if (proc.finalFailed) return failedReply(proc.message!);
  const p = Math.max(Number(task.progress) || 0, st.progress ?? 0);
  if (p !== task.progress) await updateTask(task.id, { progress: p });
  return processingReply(task.id, p);
}
