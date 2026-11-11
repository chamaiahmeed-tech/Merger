import { createClient, type InValue } from "@libsql/client";

// عميل Turso واحد عبر HTTP — إلزامي للتوافق مع Vercel (لا ملفات SQLite محلية في الإنتاج)
export const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

let schemaPromise: Promise<void> | null = null;

// إنشاء الجداول عند أول وصول — لا حاجة لأداة migrations
export function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    await turso.execute(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )`);
    await turso.execute(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  })();
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await turso.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function query<T = Record<string, unknown>>(sql: string, args: InValue[] = []): Promise<T[]> {
  await ensureSchema();
  const rs = await turso.execute({ sql, args });
  return rs.rows.map((row) => Object.fromEntries(rs.columns.map((c) => [c, row[c]]))) as T[];
}

// ====== أدوات مساعدة ======
export function safeParse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function safeParseArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseUrls(json: string | null | undefined): string[] {
  return safeParseArray(json).filter((u): u is string => typeof u === "string");
}

// ====== عمليات المهام ======
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  attemptsAppend?: Record<string, unknown>;
}

export async function insertTask(t: {
  id: string;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
}): Promise<void> {
  await query(
    `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress, attempts_json)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, '[]')`,
    [t.id, t.model, t.type, t.prompt, t.params_json]
  );
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const rows = await query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

// تحديث جزئي: يضيف attempts تلقائيًا ويضبط completed_at عند الاكتمال
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      sets.push("completed_at = COALESCE(completed_at, ?)");
      args.push(new Date().toISOString());
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(patch.progress);
  }
  if (patch.result_urls_json !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls_json);
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (patch.attemptsAppend) {
    const rows = await query<TaskRow>(`SELECT attempts_json FROM tasks WHERE id = ?`, [id]);
    const arr = safeParseArray(rows[0]?.attempts_json);
    arr.push({ ...patch.attemptsAppend, at: new Date().toISOString() });
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(arr));
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
  args.push(id);
  await query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  args.push(limit);
  return query<TaskRow>(
    `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args
  );
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  const rows = await query<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`);
  const s = { total: 0, completed: 0, failed: 0, processing: 0 };
  for (const r of rows) {
    const n = Number(r.c);
    s.total += n;
    if (r.status === "completed") s.completed = n;
    else if (r.status === "failed") s.failed = n;
    else s.processing += n; // pending + processing
  }
  return s;
}
