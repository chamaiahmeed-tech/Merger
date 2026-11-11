"use client";

/**
 * بطاقة «مدير المفاتيح»: إضافة مفاتيح المزودين (kie.ai / CometAPI)،
 * عرضها مع حالة كل مفتاح وإحصاءاته، وتعطيل/تنشيط/حذف كل مفتاح.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Badge,
  ErrorHint,
  fetchJson,
  formatDateTime,
  LoadingHint,
  relativeTime,
  SectionCard,
  type BadgeTone,
  type KeyDTO,
  type KeyStatus,
  type ProviderId,
} from "./shared";

const PROVIDERS: Record<ProviderId, { label: string; tone: BadgeTone }> = {
  kie: { label: "kie.ai", tone: "cyan" },
  cometapi: { label: "CometAPI", tone: "violet" },
};

const KEY_STATUS: Record<KeyStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "نشط", tone: "green" },
  exhausted: { label: "مستنزف", tone: "amber" },
  disabled: { label: "معطّل", tone: "slate" },
};

const EXPLAINER =
  "أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.";

const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none focus:ring-1 focus:ring-cyan-400/40";

const keyIcon = (
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
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const eyeOpen = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const eyeClosed = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const plusIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function KeysManager() {
  const [keys, setKeys] = useState<KeyDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState<ProviderId>("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const data = await fetchJson<{ keys: KeyDTO[] }>("/api/keys");
      setKeys(Array.isArray(data.keys) ? data.keys : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const addKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (apiKey.trim() === "") {
      setFormError("يرجى لصق المفتاح أولًا");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await fetchJson<{ key: KeyDTO }>(
        "/api/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            apiKey: apiKey.trim(),
            label: label.trim() === "" ? undefined : label.trim(),
          }),
        },
        "تعذّر إضافة المفتاح",
      );
      setApiKey("");
      setLabel("");
      setShowKey(false);
      await loadKeys();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "تعذّر إضافة المفتاح");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStatus = async (item: KeyDTO) => {
    const nextStatus: KeyStatus = item.status === "active" ? "disabled" : "active";
    setBusyId(item.id);
    setRowError(null);
    try {
      await fetchJson<{ key: KeyDTO }>(
        `/api/keys/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
        "تعذّر تحديث حالة المفتاح",
      );
      await loadKeys();
    } catch (err) {
      setRowError({ id: item.id, message: err instanceof Error ? err.message : "تعذّر تحديث حالة المفتاح" });
    } finally {
      setBusyId(null);
    }
  };

  const deleteKey = async (item: KeyDTO) => {
    const shownName = item.label !== "" ? item.label : item.maskedKey;
    if (!window.confirm(`هل تريد حذف المفتاح «${shownName}»؟ لا يمكن التراجع.`)) return;
    setBusyId(item.id);
    setRowError(null);
    try {
      await fetchJson<{ ok: boolean }>(
        `/api/keys/${encodeURIComponent(item.id)}`,
        { method: "DELETE" },
        "تعذّر حذف المفتاح",
      );
      await loadKeys();
    } catch (err) {
      setRowError({ id: item.id, message: err instanceof Error ? err.message : "تعذّر حذف المفتاح" });
    } finally {
      setBusyId(null);
    }
  };

  let listBody: ReactNode;
  if (keys === null) {
    listBody =
      loadError === null ? (
        <LoadingHint label="جارٍ تحميل المفاتيح…" />
      ) : (
        <ErrorHint message={loadError} onRetry={() => void loadKeys()} />
      );
  } else if (keys.length === 0) {
    listBody = (
      <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm leading-7 text-slate-500">
        لا توجد مفاتيح بعد — أضف أول مفتاح من النموذج أعلاه ليعمل التوليد.
      </p>
    );
  } else {
    listBody = (
      <ul className="space-y-3">
        {keys.map((item) => (
          <KeyRow
            key={item.id}
            item={item}
            busy={busyId === item.id}
            error={rowError !== null && rowError.id === item.id ? rowError.message : null}
            onToggle={() => void toggleStatus(item)}
            onDelete={() => void deleteKey(item)}
          />
        ))}
      </ul>
    );
  }

  return (
    <SectionCard badge="أ" title="مدير المفاتيح" icon={keyIcon}>
      <p className="mb-5 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-6 text-slate-300">
        <span aria-hidden="true" className="ml-1">💡</span>
        {EXPLAINER}
      </p>

      <form onSubmit={addKey} className="mb-6" noValidate>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
            aria-label="المزود"
            className={`${inputClass} sm:w-36 sm:shrink-0`}
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>

          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="التسمية (اختياري)"
            maxLength={60}
            className={`${inputClass} sm:flex-1`}
          />

          <div dir="ltr" className="relative min-w-0 sm:flex-[2]">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="الصق المفتاح السري هنا"
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} pe-10 font-mono`}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "إخفاء المفتاح" : "إظهار المفتاح"}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-slate-300"
            >
              {showKey ? eyeClosed : eyeOpen}
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-l from-cyan-400 to-violet-500 px-5 text-sm font-bold text-slate-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {plusIcon}
            {submitting ? "جارٍ الإضافة…" : "إضافة مفتاح"}
          </button>
        </div>
        {formError !== null ? <p className="mt-2 text-xs text-red-400">{formError}</p> : null}
      </form>

      {listBody}
    </SectionCard>
  );
}

function KeyRow({
  item,
  busy,
  error,
  onToggle,
  onDelete,
}: {
  item: KeyDTO;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const providerMeta = PROVIDERS[item.provider] ?? { label: item.provider, tone: "slate" as BadgeTone };
  const statusMeta = KEY_STATUS[item.status] ?? { label: item.status, tone: "slate" as BadgeTone };

  return (
    <li
      className={`rounded-xl border bg-slate-950/50 p-4 transition-colors ${
        busy ? "border-cyan-400/40" : "border-slate-800 hover:border-slate-700"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={providerMeta.tone}>{providerMeta.label}</Badge>
        <span dir="ltr" className="font-mono text-sm tracking-wide text-slate-100">
          {item.maskedKey}
        </span>
        {item.label ? <span className="text-sm text-slate-300">«{item.label}»</span> : null}
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
        {item.lastUsedAt ? (
          <span className="ms-auto text-[11px] text-slate-500" title={formatDateTime(item.lastUsedAt)}>
            آخر استخدام: {relativeTime(item.lastUsedAt)}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          الاستخدام: <span className="font-semibold text-slate-200">{item.usageCount}</span>
          <span className="mx-1 text-slate-600">•</span>
          نجاح: <span className="font-semibold text-green-400">{item.successCount}</span>
          <span className="mx-1 text-slate-600">•</span>
          فشل: <span className="font-semibold text-red-400">{item.failCount}</span>
        </span>
        <span>أُنشئ: {formatDateTime(item.createdAt)}</span>
      </div>

      {item.lastError ? <p className="mt-2 text-xs leading-5 text-red-400">آخر خطأ: {item.lastError}</p> : null}
      {error !== null ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:border-cyan-400/50 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {item.status === "active" ? "تعطيل" : "تنشيط"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded-lg border border-red-400/30 px-3 py-1.5 text-xs font-semibold text-red-400 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          حذف
        </button>
      </div>
    </li>
  );
}
