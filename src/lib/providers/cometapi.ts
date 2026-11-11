import { ProviderError, type CheckResult, type ProviderAdapter } from "./types";

// CometAPI — المزود الثاني:
// - الصور: نقطة متوافقة مع OpenAI تعيد النتيجة فورًا (توثيق apidoc.cometapi.com/api/image/openai/images)
// - الفيديو: نقطة مهام غير متزامنة (شكل مبدئي وفق نقاط videos المتوافقة مع OpenAI —
//   يُراجَع against apidoc.cometapi.com عند تفعيل مفاتيح CometAPI؛ غير مختبر لغياب مفتاح)
const BASE = "https://api.cometapi.com";

function extractError(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object") {
    const m = (body.error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (typeof body.message === "string") return body.message;
  if (typeof body.msg === "string") return body.msg;
  return undefined;
}

async function cometRequest(
  path: string,
  apiKey: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ProviderError("network", e instanceof Error ? e.message : String(e));
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  if (!res.ok) {
    throw new ProviderError(res.status, extractError(body) || `CometAPI HTTP ${res.status}`);
  }
  return { status: res.status, body: body ?? {} };
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة — تعيد الرابط/ب64 فورًا
  async createImageSync(apiKey, providerModel, input) {
    const payload: Record<string, unknown> = { model: providerModel, prompt: input.prompt };
    if (typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto") {
      // نقطة OpenAI تستخدم size — نحوّل النسبة الشائعة، والباقي يُترك للمزود
      const map: Record<string, string> = {
        "1:1": "1024x1024",
        "16:9": "1792x1024",
        "9:16": "1024x1792",
        "3:2": "1536x1024",
        "2:3": "1024x1536",
      };
      if (map[input.aspect_ratio]) payload.size = map[input.aspect_ratio];
    }
    const { body } = await cometRequest("/v1/images/generations", apiKey, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = body.data as Array<{ url?: string; b64_json?: string }> | undefined;
    const urls: string[] = [];
    for (const item of data ?? []) {
      if (item?.url) urls.push(item.url);
      else if (item?.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`); // رابط بيانات — لا ننزّل أي ملف على السيرفر
    }
    if (!urls.length) throw new ProviderError(502, "CometAPI: لا توجد روابط صور في الاستجابة");
    return { urls };
  },

  async createTask(apiKey, providerModel, input) {
    const payload: Record<string, unknown> = { model: providerModel, prompt: input.prompt };
    if (typeof input.image_url === "string" && input.image_url) payload.input_reference = input.image_url;
    const { body } = await cometRequest("/v1/videos", apiKey, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const id = (body.id ?? body.task_id) as string | undefined;
    if (!id) throw new ProviderError(502, "CometAPI: استجابة إنشاء مهمة الفيديو بلا معرّف");
    return { providerTaskId: id };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const { body } = await cometRequest(`/v1/videos/${encodeURIComponent(providerTaskId)}`, apiKey);
    const status = String(body.status ?? "").toLowerCase();
    if (["completed", "succeeded", "success"].includes(status)) {
      const urls: string[] = [];
      const out = body.output ?? body.result ?? body;
      if (typeof out === "string") urls.push(out);
      else if (Array.isArray(out)) for (const u of out) if (typeof u === "string") urls.push(u);
      else if (out && typeof out === "object") {
        const o = out as { url?: unknown; video_url?: unknown };
        if (typeof o.url === "string") urls.push(o.url);
        else if (typeof o.video_url === "string") urls.push(o.video_url);
      }
      if (urls.length) return { status: "completed", urls };
      return { status: "failed", error: "CometAPI: اكتملت المهمة بلا رابط ناتج" };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return { status: "failed", error: extractError(body) || "فشل المزود CometAPI" };
    }
    return {
      status: "processing",
      progress: typeof body.progress === "number" ? body.progress : 40,
    };
  },
};
