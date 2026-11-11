"use client";

/**
 * بطاقة «ربط السيرفر»: عنوان MCP مع زر نسخ، ثلاث تبويبات بقصاصات JSON
 * (ChatGPT / Claude Desktop / Cursor)، رقائق الأدوات الخمس، وملاحظة الفيديو.
 */

import { useEffect, useState, type ReactNode } from "react";
import { CopyButton, SectionCard } from "./shared";

type TabId = "chatgpt" | "claude" | "cursor";

const TABS: { id: TabId; label: string }[] = [
  { id: "chatgpt", label: "ChatGPT / GPT Agents" },
  { id: "claude", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor / Windsurf / Cline" },
];

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي" },
  { name: "generate_video", desc: "توليد فيديو مع صوت متزامن" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد" },
  { name: "get_task", desc: "متابعة حالة أي مهمة بمعرّفها" },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا" },
];

const codeChip = "rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px] text-cyan-300";

const CAPTIONS: Record<TabId, ReactNode> = {
  chatgpt: (
    <>
      في ChatGPT: <span dir="ltr">Settings → Connectors → Create → Custom MCP server</span> وضع الرابط في{" "}
      <code dir="ltr" className={codeChip}>
        &quot;Server URL&quot;
      </code>
      .
    </>
  ),
  claude: (
    <>
      أضِفه إلى ملف{" "}
      <code dir="ltr" className={codeChip}>
        claude_desktop_config.json
      </code>
      .
    </>
  ),
  cursor: (
    <>
      أضِفه إلى{" "}
      <code dir="ltr" className={codeChip}>
        mcp.json
      </code>{" "}
      في Cursor / Windsurf / Cline.
    </>
  ),
};

/** بناء قصاصة JSON لتبويب معيّن (مع ترويسات المصادقة عند الحاجة). */
function buildSnippet(kind: "plain" | "http", mcpUrl: string, authRequired: boolean): string {
  const server: Record<string, unknown> = kind === "http" ? { type: "http", url: mcpUrl } : { url: mcpUrl };
  if (authRequired) {
    server.headers = { Authorization: "Bearer <MCP_ACCESS_TOKEN>" };
  }
  return JSON.stringify({ mcpServers: { "media-generator": server } }, null, 2);
}

const serverIcon = (
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
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);

export default function ConnectCard({ authRequired = false }: { authRequired?: boolean }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("chatgpt");

  /* القراءة من window داخل useEffect فقط لتجنّب اختلاف الترطيب (hydration mismatch). */
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = origin === null ? "" : `${origin}/mcp`;

  const snippets: Record<TabId, string> = {
    chatgpt: buildSnippet("plain", mcpUrl, authRequired),
    claude: buildSnippet("http", mcpUrl, authRequired),
    cursor: buildSnippet("http", mcpUrl, authRequired),
  };
  const currentSnippet = snippets[tab];

  return (
    <SectionCard badge="ج" title="ربط السيرفر" icon={serverIcon}>
      {/* عنوان MCP */}
      <div className="mb-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="mb-2 text-xs font-bold text-slate-300">عنوان خادم MCP</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            dir="ltr"
            value={mcpUrl}
            placeholder={origin === null ? "…" : undefined}
            className="h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-cyan-300 placeholder:text-slate-500 focus:outline-none sm:flex-1"
          />
          <CopyButton
            value={mcpUrl}
            copiedText="تم النسخ ✓"
            ariaLabel="نسخ عنوان MCP"
            disabled={mcpUrl === ""}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-l from-cyan-400 to-violet-500 px-5 text-sm font-bold text-slate-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            نسخ
          </CopyButton>
        </div>
        {authRequired ? (
          <p className="mt-2 text-xs leading-6 text-cyan-300/90">
            هذا السيرفر يتطلب مصادقة — استبدل{" "}
            <span dir="ltr" className="font-mono">
              &lt;MCP_ACCESS_TOKEN&gt;
            </span>{" "}
            في الإعدادات أدناه بمفتاح الوصول الخاص بك.
          </p>
        ) : null}
      </div>

      {/* التبويبات */}
      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              tab === t.id
                ? "bg-gradient-to-l from-cyan-400 to-violet-500 text-slate-950"
                : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
            }`}
          >
            <span dir="ltr">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">إعداد الاتصال بصيغة JSON</span>
        <CopyButton
          value={currentSnippet}
          copiedText="تم النسخ ✓"
          ariaLabel="نسخ إعداد JSON"
          className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-cyan-400/50 hover:text-cyan-300"
        >
          نسخ JSON
        </CopyButton>
      </div>
      <pre
        dir="ltr"
        className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200"
      >
        {currentSnippet}
      </pre>
      <p className="mt-2 text-xs leading-6 text-slate-400">{CAPTIONS[tab]}</p>

      {/* الأدوات */}
      <div className="mt-6">
        <p className="mb-3 text-sm font-bold text-slate-200">أدوات السيرفر</p>
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((tool) => (
            <span key={tool.name} className="rounded-full bg-gradient-to-l from-cyan-400/70 to-violet-500/70 p-px">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-full bg-slate-950 px-3 py-1.5">
                <code dir="ltr" className="font-mono text-[11px] text-cyan-300">
                  {tool.name}
                </code>
                <span className="text-xs text-slate-300">{tool.desc}</span>
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* ملاحظة الفيديو */}
      <div className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
        <p className="flex gap-2 text-xs leading-6 text-amber-200">
          <span aria-hidden="true" className="shrink-0">
            ⚠️
          </span>
          <span>
            الفيديو يحتاج دقائق: يعيد السيرفر{" "}
            <code dir="ltr" className="font-mono text-amber-300">
              task_id
            </code>{" "}
            فورًا، ويتابَع تلقائيًا بـ{" "}
            <code dir="ltr" className="font-mono text-amber-300">
              get_task
            </code>{" "}
            كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي{" "}
            <span dir="ltr">(Progress notifications)</span> حتى لا تنقطع العملية.
          </span>
        </p>
      </div>
    </SectionCard>
  );
}
