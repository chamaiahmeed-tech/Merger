import { ProviderError, type CheckResult, type ProviderAdapter } from "./types";

//kie.ai — Jobs API الموحد (الأشكال المقاسة فعليًا بـ curl):
// createTask → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
// recordInfo → data.state: waiting|queuing|generating|success|fail
//              data.resultJson نص JSON داخل JSON يحتاج JSON.parse ثانية
// خطأ 401    → {"code":401,"msg":"Unauthorized – Authentication failed..."}
// موديل خاطئ → {"code":422,"msg":"The model name you specified is not supported..."}
const BASE = "https://api.kie.ai/api/v1/jobs";

async function kieRequest(path: string, apiKey: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة/مهلة — يُصنَّف temporary لاحقًا
    throw new ProviderError("network", e instanceof Error ? e.message : String(e));
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  const code = typeof body?.code === "number" ? body.code : res.status;
  if (!res.ok || code !== 200) {
    const msg = (body?.msg as string) || (body?.message as string) || `kie.ai HTTP ${res.status}`;
    throw new ProviderError(code, msg);
  }
  return body ?? {};
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input) {
    const body = await kieRequest("createTask", apiKey, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const data = body.data as { taskId?: string } | undefined;
    if (!data?.taskId) throw new ProviderError(502, "kie.ai: استجابة createTask بلا taskId");
    return { providerTaskId: data.taskId };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const body = await kieRequest(`recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, apiKey);
    const data = (body.data ?? {}) as Record<string, unknown>;
    const state = String(data.state ?? "");
    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانية (شكل مقاس فعليًا)
      let urls: string[] = [];
      const raw = data.resultJson;
      if (typeof raw === "string" && raw.trim()) {
        try {
          const j = JSON.parse(raw);
          if (Array.isArray(j?.resultUrls)) urls = j.resultUrls.filter((u: unknown) => typeof u === "string");
        } catch {
          /* تجاهل */
        }
      }
      if (!urls.length) {
        const resp = data.response as { resultUrls?: unknown } | undefined;
        if (Array.isArray(resp?.resultUrls)) urls = resp.resultUrls.filter((u): u is string => typeof u === "string");
      }
      return { status: "completed", urls };
    }
    if (state === "fail") {
      const msg = String(data.failMsg || data.errorMessage || "فشل المزود kie.ai");
      return { status: "failed", error: msg };
      // ملاحظة: تصنيف الخطأ (مفتاح/رصيد/مؤقت/معطيات) يحدث في المنسّق وفق رسالة الفشل
    }
    // waiting | queuing | generating — لا يقدم kie تقدمًا رقميًا، نستخدم تقديرًا مرحليًا
    const progress = state === "generating" ? 55 : state === "queuing" ? 25 : 10;
    return { status: "processing", progress };
  },
};
