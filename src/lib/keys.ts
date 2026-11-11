import { randomUUID } from "node:crypto";
import { query, updateTask } from "./turso";

// ====== نظام المفاتيح المتسلسلة (قلب المشروع) ======

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

const AUTH_RE = /invalid\s*api\s*key|unauthorized|forbidden|authenticat|api\s*key/i;
const EXHAUSTED_RE = /insufficient|quota|balance|credit|exhausted|充值|out\s*of\s*credits/i;
const MODEL_RE = /model\s*not\s*found|unsupported\s*model|not\s*supported|unknown\s*model/i;

// تصنيف موحد لأخطاء المزودين (جدول 4.2)
// ملاحظة: نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
export function classifyProviderError(status: number | string | undefined, message: string): ErrorClass {
  const s = status != null && status !== "network" ? Number(status) : undefined;
  const m = message || "";
  if (AUTH_RE.test(m) || s === 401 || s === 403) return "disabled";
  if (s === 402 || EXHAUSTED_RE.test(m)) return "exhausted";
  if (MODEL_RE.test(m) && (s === 400 || s === 404 || s === 422)) return "provider";
  if (s === 400 || s === 422) return "params";
  // 429، 5xx، انقطاع شبكة، timeout، abort — وأي غير معروف نعامله كمؤقت لعدم إيقاف المهمة
  return "temporary";
}

// جلب المفاتيح غير المعطّلة بهذا الترتيب بالضبط:
// أول مفتاح أُضيف يُجرَّب أولًا ثم الثاني ثم الثالث — ترتيب تسلسلي مقصود، ليس round-robin
export async function getKeyPool(providers: readonly string[]): Promise<KeyRow[]> {
  const ph = providers.map(() => "?").join(", ");
  return query<KeyRow>(
    `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${ph}) ORDER BY created_at ASC, id ASC`,
    [...providers]
  );
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  const rows = await query<KeyRow>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export class DuplicateKeyError extends Error {
  constructor() {
    super("هذا المفتاح مضاف مسبقًا لنفس المزود");
  }
}

export async function addKey(provider: string, apiKey: string, label: string): Promise<KeyRow> {
  const dup = await query<{ id: string }>(`SELECT id FROM api_keys WHERE provider = ? AND api_key = ?`, [
    provider,
    apiKey,
  ]);
  if (dup.length) throw new DuplicateKeyError();
  const id = randomUUID();
  const now = new Date().toISOString();
  await query(
    `INSERT INTO api_keys (id, provider, label, api_key, status, usage_count, success_count, fail_count, created_at)
     VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?)`,
    [id, provider, label, apiKey, now]
  );
  return (await getKeyById(id))!;
}

export function toKeyDTO(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label || "",
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: Number(k.usage_count) || 0,
    successCount: Number(k.success_count) || 0,
    failCount: Number(k.fail_count) || 0,
    lastUsedAt: k.last_used_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

export async function listKeys(): Promise<ReturnType<typeof toKeyDTO>[]> {
  const rows = await query<KeyRow>(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
  return rows.map(toKeyDTO);
}

export async function updateKeyStatus(id: string, status: "active" | "disabled"): Promise<KeyRow | null> {
  const rows = await query<KeyRow>(`UPDATE api_keys SET status = ? WHERE id = ? RETURNING *`, [status, id]);
  return rows[0] ?? null;
}

export async function deleteKey(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM api_keys WHERE id = ? RETURNING id`, [id]);
  return rows.length > 0;
}

// تحديث عدادات المفتاح دائمًا (نجاح أو فشل) + تسجيل المحاولة في سجل المهمة
export async function recordKeyAttempt(
  taskId: string,
  key: KeyRow,
  ok: boolean,
  failure?: { cls: ErrorClass; error: string }
): Promise<void> {
  const now = new Date().toISOString();
  const sets: string[] = ["usage_count = usage_count + 1", "last_used_at = ?", "last_checked_at = ?"];
  const args: (string | number | null)[] = [now, now];
  if (ok) {
    sets.push("success_count = success_count + 1", "last_error = NULL");
    // نجاح مفتاح كان مستنزفًا → عاد للعمل (المستخدم شحن الرصيد)
    sets.push("status = 'active'");
  } else {
    sets.push("fail_count = fail_count + 1", "last_error = ?");
    args.push((failure?.error || "").slice(0, 500));
    if (failure?.cls === "disabled") sets.push("status = 'disabled'");
    else if (failure?.cls === "exhausted") sets.push("status = 'exhausted'");
  }
  args.push(key.id);
  await query(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args);
  // سجل المحاولة في المهمة
  await updateTask(taskId, {
    attemptsAppend: {
      provider: key.provider,
      keyId: key.id,
      keyLabel: key.label || maskKey(key.api_key),
      ok,
      ...(failure ? { errorClass: failure.cls, error: (failure.error || "").slice(0, 300) } : {}),
    },
  });
}
