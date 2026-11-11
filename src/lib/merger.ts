import { ProviderError } from "./providers/types";

// ====== عميل خدمة دمج الفيديو — Video Merger API v2 ======
// بلا مفاتيح أو توثيق. المخرجات MP4 (H.264 + AAC). لا توجد معاملات resolution/fps.
// الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt في الاستجابات).

// عنوان الخدمة — القيم الفارغة أو العنصر النائب تُعامل كغير مهيأة
export function mergerBase(): string | null {
  const b = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  if (!b || b.includes("xxxx")) return null;
  return b;
}

// فحص الجهوزية: GET {base}/api/config بمهلة 4 ثوانٍ
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 20_000
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = mergerBase();
  if (!base) throw new ProviderError(500, "خدمة الدمج غير مهيأة");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
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
  return { status: res.status, body: body ?? {} };
}

export async function createMergeJob(
  videos: string[]
): Promise<{ jobId: string; statusUrl?: string; processUrl?: string; expiresAt?: string }> {
  const { status, body } = await mergerFetch("/api/jobs", { method: "POST", body: JSON.stringify({ videos }) });
  if (status >= 400 || !body.jobId) {
    const msg = typeof body.error === "string" ? body.error : `فشل إنشاء مهمة الدمج (HTTP ${status})`;
    throw new ProviderError(status, msg);
  }
  return {
    jobId: String(body.jobId),
    statusUrl: typeof body.statusUrl === "string" ? body.statusUrl : undefined,
    processUrl: typeof body.processUrl === "string" ? body.processUrl : undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
}

// يستغرق ~10–15 ثانية (blocking). 200 → done، 202 → قيد المعالجة، خطأ → ProviderError
export async function processMergeJob(jobId: string): Promise<Record<string, unknown>> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 180_000);
  if (status === 202) return body;
  if (status >= 400) {
    const msg = typeof body.error === "string" ? body.error : `فشل تنفيذ الدمج (HTTP ${status})`;
    throw new ProviderError(status, msg);
  }
  return body;
}

export interface MergerStatus {
  status: "queued" | "uploading" | "processing" | "done" | "failed" | "unknown";
  progress: number;
  videoUrl?: string;
  error?: string;
}

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAIL_RE = /^(error|failed|failure|cancelled|canceled)$/i;

// تحليل دفاعي لحالة المهمة (قسم 7.2 من المواصفة)
export async function getMergeJob(jobId: string): Promise<MergerStatus> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (status === 404) {
    throw new ProviderError(404, typeof body.error === "string" ? body.error : "مهمة الدمج غير موجودة");
  }
  if (status >= 400) {
    throw new ProviderError(status, typeof body.error === "string" ? body.error : `خدمة الدمج HTTP ${status}`);
  }
  const raw = String(body.status ?? "").toLowerCase();
  let norm: MergerStatus["status"] = "unknown";
  if (DONE_RE.test(raw)) norm = "done";
  else if (FAIL_RE.test(raw)) norm = "failed";
  else if (["queued", "uploading", "processing"].includes(raw)) norm = raw as MergerStatus["status"];
  // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  if (norm === "unknown" && typeof body.error === "string" && body.error) {
    return { status: "failed", progress: 0, error: body.error };
  }
  let progress = typeof body.progress === "number" ? body.progress : norm === "done" ? 100 : 0;
  if (progress > 0 && progress <= 1) progress = progress * 100; // قد يأتي كسرًا 0..1
  let videoUrl = (typeof body.videoUrl === "string" && body.videoUrl) || (typeof body.downloadUrl === "string" && body.downloadUrl) || undefined;
  if (norm === "done" && !videoUrl) {
    // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط الرابط من المعرّف
    videoUrl = `${mergerBase()}/api/jobs/${encodeURIComponent(jobId)}/video`;
  }
  return {
    status: norm,
    progress: Math.round(Math.min(100, Math.max(0, progress))),
    videoUrl,
    error: typeof body.error === "string" ? body.error : undefined,
  };
}

export async function deleteMergeJob(jobId: string): Promise<boolean> {
  try {
    const { status } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    return status < 400;
  } catch {
    return false; // تنظيف اختياري — لا نُفشل المهمة بسبب فشل الحذف
  }
}
