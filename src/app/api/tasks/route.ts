import { listRecentTasks, parseUrls, safeParseArray, taskStats, type TaskRow } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function taskToDTO(t: TaskRow) {
  return {
    id: t.id,
    type: t.type,
    model: t.model,
    provider: t.provider,
    status: t.status,
    progress: Number(t.progress) || 0,
    prompt: t.prompt,
    resultUrls: parseUrls(t.result_urls_json),
    errorMessage: t.error_message,
    attemptsCount: safeParseArray(t.attempts_json).length,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const [stats, tasks] = await Promise.all([taskStats(), listRecentTasks(limit, { type, status })]);
  return Response.json({ stats, tasks: tasks.map(taskToDTO) });
}
