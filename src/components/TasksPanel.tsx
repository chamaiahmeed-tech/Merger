"use client";

/**
 * بطاقة «لوحة المهام»: إحصاءات فورية + قائمة مهام تُحدَّث تلقائيًا كل 5 ثوانٍ،
 * مع شريط تقدم للمهام الجارية وروابط النتائج للمكتملة وسبب الفشل للفاشلة.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  CopyButton,
  ErrorHint,
  fetchJson,
  formatDateTime,
  LoadingHint,
  relativeTime,
  SectionCard,
  truncateText,
  type BadgeTone,
  type TaskDTO,
  type TaskStatus,
  type TaskType,
} from "./shared";

const TASK_TYPES: Record<TaskType, { label: string; emoji: string; tone: BadgeTone }> = {
  image: { label: "صورة", emoji: "🖼️", tone: "cyan" },
  video: { label: "فيديو", emoji: "🎬", tone: "violet" },
  merge: { label: "دمج", emoji: "🔗", tone: "green" },
};

const TASK_STATUS: Record<TaskStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "قيد الانتظار", tone: "slate" },
  processing: { label: "قيد المعالجة", tone: "amber" },
  completed: { label: "مكتملة", tone: "green" },
  failed: { label: "فاشلة", tone: "red" },
};

const TONE_TEXT: Record<BadgeTone, string> = {
  green: "text-green-400",
  amber: "text-amber-400",
  red: "text-red-400",
  slate: "text-slate-300",
  cyan: "text-cyan-300",
  violet: "text-violet-300",
};

interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

interface TasksResponse {
  stats: TaskStats;
  tasks: TaskDTO[];
}

function emptyStats(tasks: TaskDTO[]): TaskStats {
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    processing: tasks.filter((t) => t.status === "processing").length,
  };
}

const copyIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3 w-3"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const refreshIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
    aria-hidden="true"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

export default function TasksPanel() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetchJson<TasksResponse>("/api/tasks?limit=20");
      const tasks = Array.isArray(res.tasks) ? res.tasks : [];
      setData({ stats: res.stats ?? emptyStats(tasks), tasks });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
    }
  }, []);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    await loadTasks();
    setRefreshing(false);
  }, [loadTasks]);

  useEffect(() => {
    void loadTasks();
    const intervalId = window.setInterval(() => void loadTasks(), 5_000);
    return () => window.clearInterval(intervalId);
  }, [loadTasks]);

  let body: ReactNode;
  if (data === null) {
    body =
      error === null ? (
        <LoadingHint label="جارٍ تحميل المهام…" />
      ) : (
        <ErrorHint message={error} onRetry={() => void loadTasks()} />
      );
  } else {
    const { stats, tasks } = data;
    body = (
      <>
        {error !== null ? (
          <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-300">
            تعذر التحديث الأخير ({error}) — ستتم المحاولة تلقائيًا بعد 5 ثوانٍ.
          </p>
        ) : null}

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatChip label="الإجمالي" value={stats.total} icon="≡" tone="slate" />
          <StatChip label="مكتملة" value={stats.completed} icon="✓" tone="green" />
          <StatChip label="فاشلة" value={stats.failed} icon="✕" tone="red" />
          <StatChip label="جارية" value={stats.processing} icon="⟳" tone="amber" />
        </div>

        {tasks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm leading-7 text-slate-500">
            لا توجد مهام بعد — كل توليد جديد سيظهر هنا مباشرة.
          </p>
        ) : (
          <ul className="space-y-3">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <SectionCard
      badge="ب"
      title="لوحة المهام"
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      }
      extra={
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-slate-500 sm:inline">تحديث تلقائي كل 5 ثوانٍ</span>
          <button
            type="button"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            aria-label="تحديث الآن"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition-colors hover:border-cyan-400/50 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={refreshing ? "animate-spin" : undefined}>{refreshIcon}</span>
          </button>
        </div>
      }
    >
      {body}
    </SectionCard>
  );
}

function StatChip({ label, value, icon, tone }: { label: string; value: number; icon: string; tone: BadgeTone }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5">
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 text-sm font-bold ${TONE_TEXT[tone]}`}
      >
        {icon}
      </span>
      <span className="flex flex-col">
        <span className={`text-lg font-extrabold leading-6 ${TONE_TEXT[tone]}`}>{value}</span>
        <span className="text-[11px] text-slate-400">{label}</span>
      </span>
    </div>
  );
}

function TaskRow({ task }: { task: TaskDTO }) {
  const typeMeta = TASK_TYPES[task.type] ?? { label: task.type, emoji: "•", tone: "slate" as BadgeTone };
  const statusMeta = TASK_STATUS[task.status] ?? { label: task.status, tone: "slate" as BadgeTone };
  const urls = task.resultUrls ?? [];
  const progress = Math.min(100, Math.max(0, Math.round(task.progress)));

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 transition-colors hover:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={typeMeta.tone}>
          <span aria-hidden="true">{typeMeta.emoji}</span>
          {typeMeta.label}
        </Badge>
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
          محاولات: {task.attemptsCount}
        </span>
        <span className="ms-auto text-[11px] text-slate-500" title={formatDateTime(task.createdAt)}>
          {relativeTime(task.createdAt)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1 text-[11px] text-slate-500">
          <span dir="ltr" className="font-mono">
            {task.id}
          </span>
          <CopyButton
            value={task.id}
            copiedText="تم ✓"
            ariaLabel="نسخ معرّف المهمة"
            className="rounded p-0.5 text-slate-600 transition-colors hover:text-cyan-300"
          >
            {copyIcon}
          </CopyButton>
        </span>
        <span dir="ltr" className="font-mono text-[11px] text-slate-400">
          {task.model}
        </span>
      </div>

      <p className="mt-2 text-sm leading-6 text-slate-300">{truncateText(task.prompt, 80)}</p>

      {task.status === "processing" ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span dir="ltr" className="w-10 text-right text-[11px] font-bold text-cyan-300">
            {progress}%
          </span>
        </div>
      ) : null}

      {task.status === "completed" && urls.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {urls.map((url, index) => (
            <a
              key={`${url}-${index}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-400/20"
            >
              {urls.length > 1 ? `فتح الرابط ${index + 1}` : "فتح الرابط"}
              <span aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
      ) : null}

      {task.status === "failed" && task.errorMessage ? (
        <p className="mt-2 text-xs leading-5 text-red-400">سبب الفشل: {task.errorMessage}</p>
      ) : null}
    </li>
  );
}
