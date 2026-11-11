"use client";

/**
 * أدوات وأنواع مشتركة بين مكوّنات لوحة الإدارة.
 * (الأنواع المطابقة لعقد الـ API + ندوة fetch موحّدة + الحافظة + الوقت + عناصر واجهة صغيرة)
 */

import { useEffect, useState, type ReactNode } from "react";

/* ============================ الأنواع ============================ */

export type ProviderId = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";
export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface KeyDTO {
  id: string;
  provider: ProviderId;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TaskDTO {
  id: string;
  type: TaskType;
  model: string;
  provider: string;
  status: TaskStatus;
  progress: number;
  prompt: string;
  resultUrls: string[] | null;
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

/* ============================ الطلبات ============================ */

/** ندوة fetch موحّدة: تحوّل أي رد غير 2xx إلى Error برسالة عربية من جسم الرد. */
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  fallbackError = "تعذر تحميل البيانات",
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("تعذر الاتصال بالسيرفر — تحقق من الشبكة وحاول من جديد");
  }
  if (!res.ok) {
    throw new Error(await extractApiError(res, fallbackError));
  }
  return (await res.json()) as T;
}

async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null && "error" in data) {
      const message: unknown = (data as { error: unknown }).error;
      if (typeof message === "string" && message.trim() !== "") return message;
    }
  } catch {
    /* الرد ليس JSON صالحًا */
  }
  return fallback;
}

/* ============================ الحافظة ============================ */

/** نسخ نص إلى الحافظة مع بديل احتياطي (execCommand) للسياقات غير الآمنة. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* نجرّب الطريقة الاحتياطية أدناه */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** زر نسخ عام: يعرض «تم النسخ ✓» لمدة ثانيتين بعد النسخ الناجح. */
export function CopyButton({
  value,
  children,
  copiedText = "تم النسخ ✓",
  className = "",
  disabled = false,
  ariaLabel,
}: {
  value: string;
  children: ReactNode;
  copiedText?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timerId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timerId);
  }, [copied]);

  const handleClick = (): void => {
    void copyText(value).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  return (
    <button type="button" onClick={handleClick} disabled={disabled} aria-label={ariaLabel} className={className}>
      {copied ? copiedText : children}
    </button>
  );
}

/* ============================ الوقت ============================ */

/* اللغة العربية مع نظام ترقيم لاتيني (ar-u-nu-latn) لعرض الأرقام بأرقام غربية. */
const RELATIVE_FMT = new Intl.RelativeTimeFormat("ar-u-nu-latn", { numeric: "auto" });
const ABSOLUTE_FMT = new Intl.DateTimeFormat("ar-u-nu-latn", { dateStyle: "medium", timeStyle: "short" });

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** وقت نسبي عربي مثل «منذ دقيقتين» مع ارجاع آمن إلى «—». */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  if (absMs < MINUTE_MS) return RELATIVE_FMT.format(Math.round(diffMs / 1000), "second");
  if (absMs < HOUR_MS) return RELATIVE_FMT.format(Math.round(diffMs / MINUTE_MS), "minute");
  if (absMs < DAY_MS) return RELATIVE_FMT.format(Math.round(diffMs / HOUR_MS), "hour");
  return RELATIVE_FMT.format(Math.round(diffMs / DAY_MS), "day");
}

/** تاريخ ووقت مطلق بصيغة عربية مقروءة. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return ABSOLUTE_FMT.format(date);
}

/* ============================ نصوص ============================ */

/** قصّ نص مع توحيد المسافات (للمقتطفات). */
export function truncateText(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/* ============================ عناصر واجهة ============================ */

const BADGE_TONES = {
  green: "border-green-400/30 bg-green-400/10 text-green-400",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  red: "border-red-400/30 bg-red-400/10 text-red-400",
  slate: "border-slate-400/30 bg-slate-400/10 text-slate-400",
  cyan: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  violet: "border-violet-400/30 bg-violet-400/10 text-violet-300",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  tone,
  children,
  className = "",
}: {
  tone: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-5 ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function LoadingHint({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400"
      />
      <span>{label}</span>
    </div>
  );
}

export function ErrorHint({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-red-400">{message ?? "تعذر تحميل البيانات"}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
        >
          إعادة المحاولة
        </button>
      ) : null}
    </div>
  );
}

/** هيكل بطاقة قسم موحّد: أيقونة + حرف ترتيب + عنوان + منطقة إضافية + محتوى. */
export function SectionCard({
  badge,
  title,
  icon,
  extra,
  children,
}: {
  badge: string;
  title: string;
  icon: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400/15 to-violet-500/15 text-cyan-300"
          >
            {icon}
          </span>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-100 sm:text-lg">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-800 text-[11px] font-bold text-slate-300">
              {badge}
            </span>
            {title}
          </h2>
        </div>
        {extra}
      </header>
      {children}
    </section>
  );
}
