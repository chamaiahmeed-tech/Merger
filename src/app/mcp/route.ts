import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getTask, listRecentTasks, parseUrls, type TaskRow } from "@/lib/turso";
import { resolveModel } from "@/lib/models";
import { failedReply, runGeneration, refreshGenerationTask, type ToolReply } from "@/lib/generation";
import { runMerge, refreshMergeTask } from "@/lib/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تمتد حتى 240 ثانية
export const maxDuration = 300;

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };
const KNOWN_TOOLS = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"] as const;

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// قناة إشعارات التقدم — تُفعَّل فقط إذا زوّد العميل الطلب بـ _meta.progressToken
function progressChannel(extra: unknown): { send?: (p: number, message: string) => Promise<void> } {
  const e = extra as {
    _meta?: { progressToken?: unknown };
    requestInfo?: { _meta?: { progressToken?: unknown } };
    sendNotification?: (n: unknown) => Promise<void>;
  };
  const token = e?._meta?.progressToken ?? e?.requestInfo?._meta?.progressToken;
  if (token == null || typeof e?.sendNotification !== "function") return {};
  return {
    send: async (progress, message) => {
      try {
        await e.sendNotification!({
          method: "notifications/progress",
          params: { progressToken: token, progress, total: 100, message },
        });
      } catch {
        /* العميل انقطع — نتجاهل */
      }
    },
  };
}

function toToolResult(reply: ToolReply) {
  return {
    content: [{ type: "text" as const, text: reply.text }],
    ...(reply.isError ? { isError: true } : {}),
  };
}

// قصاصة العرض في قائمة list_media
function formatListMedia(tasks: TaskRow[]): string {
  if (!tasks.length) return "لا توجد وسائط مخزنة بعد.";
  const lines = tasks.map((t, i) => {
    const typeAr = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
    const statusAr =
      t.status === "completed"
        ? "✅ مكتملة"
        : t.status === "failed"
          ? "❌ فاشلة"
          : t.status === "processing"
            ? "⏳ قيد المعالجة"
            : "🕒 قيد الانتظار";
    let s = `${i + 1}. [${typeAr}] ${statusAr} — ${t.created_at}\n   task_id: ${t.id}\n   الموديل: ${t.model}`;
    const urls = parseUrls(t.result_urls_json);
    if (urls.length) s += `\n   الرابط: ${urls.join("\n   الرابط: ")}`;
    if (t.status === "failed" && t.error_message) s += `\n   الخطأ: ${t.error_message}`;
    return s;
  });
  return `📂 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "توليد صورة بـ gpt-image-2-6/flare-text-to-image (تبديل تلقائي عبر كل المفاتيح النشطة). تعيد رابط الصورة جاهزًا إذا اكتملت خلال نافذة الانتظار، وإلا تعيد task_id — استدعِ get_task كل ~10 ثوانٍ حتى completed ثم اعرض الرابط وتوقف.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const def = resolveModel(args.model);
      if (!def || def.type !== "image") {
        return toToolResult(
          failedReply(
            `موديل غير معروف: ${args.model}. المتاح: gpt-image-2-6/flare-text-to-image (صور)، grok-imagine-video-1-5-preview (فيديو)`
          )
        );
      }
      // نمرّر فقط الحقول غير الافتراضية لتقليل احتمال رفض المزود
      const input: Record<string, unknown> = { prompt: args.prompt };
      if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
      if (args.resolution && args.resolution !== "1K") input.resolution = args.resolution;
      if (args.background && args.background !== "auto") input.background = args.background;
      if (args.output_format && args.output_format !== "png") input.output_format = args.output_format;
      const { send } = progressChannel(extra);
      return toToolResult(
        await runGeneration({ type: "image", def, input, prompt: args.prompt, waitSeconds: args.wait_seconds, notify: send })
      );
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن أصلي، image-to-video اختياري). الفيديو يحتاج دقائق: انتظار قصير مع بث تقدم ثم task_id — تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const def = resolveModel(args.model);
      if (!def || def.type !== "video") {
        return toToolResult(
          failedReply(
            `موديل غير معروف: ${args.model}. المتاح: gpt-image-2-6/flare-text-to-image (صور)، grok-imagine-video-1-5-preview (فيديو)`
          )
        );
      }
      // الموديل يولّد الصوت تلقائيًا ويثبّت المدة في هذه النسخة — نمرّر المؤكد قبوله فقط
      const input: Record<string, unknown> = { prompt: args.prompt };
      if (args.image_url) input.image_url = args.image_url;
      if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
      const { send } = progressChannel(extra);
      return toToolResult(
        await runGeneration({ type: "video", def, input, prompt: args.prompt, waitSeconds: args.wait_seconds, notify: send })
      );
    }
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      description:
        "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى. مرر urls (روابط فيديو مباشرة عامة — مثل روابط generate_video) أو task_ids (لمهام فيديو مكتملة تُحل روابطها من قاعدة البيانات بالترتيب — مثالي بعد توليد عدة مقاطع). الدمج سريع عادةً: انتظار قصير مع بث تقدم ثم task_id للدمج — تابعه بـ get_task. ملاحظة: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .max(10, "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. Max 10 clips."),
        task_ids: z
          .array(z.string())
          .max(10, "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. Max 10."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const { send } = progressChannel(extra);
      return toToolResult(
        await runMerge({ urls: args.urls ?? [], taskIds: args.task_ids ?? [], waitSeconds: args.wait_seconds, notify: send })
      );
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "تتبع أي مهمة بمعرّفها — توليد صور/فيديو ودمج (يقرأ قاعدة Turso ويحدّث من المزود/الخدمة إن كانت جارية). استعلمه كل ~10 ثوانٍ؛ عند completed ستجد روابط النتائج — اعرضها للمستخدم وتوقف عن الاستعلام.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      const task = await getTask(args.task_id);
      if (!task) return toToolResult(failedReply(`لم يتم العثور على المهمة المطلوبة: ${args.task_id}`));
      const reply = task.type === "merge" ? await refreshMergeTask(task) : await refreshGenerationTask(task);
      return toToolResult(reply);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) — لاسترجاع نتائج سابقة.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      return { content: [{ type: "text" as const, text: formatListMedia(tasks) }] };
    }
  );

  return server;
}

async function handleWithTransport(req: Request, parsed?: unknown): Promise<Response> {
  // وضع بدون جلسات (stateless) — الأنسب لبيئة serverless على Vercel
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  await server.connect(transport);
  // ملاحظة: لا نستدعي close هنا — تنفيذ الأداة قد يستمر بعد إرجاع الاستجابة (بث التقدم الحي عبر SSE)
  return transport.handleRequest(req, parsed !== undefined ? { parsedBody: parsed } : undefined);
}

function authOk(req: Request): boolean {
  if (!process.env.MCP_ACCESS_TOKEN) return true;
  return (req.headers.get("authorization") || "") === `Bearer ${process.env.MCP_ACCESS_TOKEN}`;
}

export async function POST(req: Request) {
  if (!authOk(req)) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: Bearer token required" } },
      { status: 401 }
    );
  }
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  // اعتراض الأدوات المجهولة برسالة عربية قبل وصولها إلى SDK
  const p = parsed as { method?: string; id?: unknown; params?: { name?: string } };
  if (
    p?.method === "tools/call" &&
    typeof p.params?.name === "string" &&
    !KNOWN_TOOLS.includes(p.params.name as (typeof KNOWN_TOOLS)[number])
  ) {
    return Response.json({
      jsonrpc: "2.0",
      id: p.id ?? null,
      result: {
        content: [
          { type: "text", text: `❌ أداة غير معروفة: ${p.params.name}. المتاح: ${KNOWN_TOOLS.join(", ")}` },
        ],
        isError: true,
      },
    });
  }
  return handleWithTransport(req, parsed);
}

export async function GET(req: Request) {
  if (!authOk(req)) {
    return Response.json({ error: "Unauthorized: Bearer token required" }, { status: 401 });
  }
  // لا نقدّم بث SSE مستقل (Server-initiated) في وضع serverless — نرد 405 وفق مواصفة MCP
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "SSE listening not supported (stateless mode)" } },
    { status: 405 }
  );
}

export async function DELETE(req: Request) {
  if (!authOk(req)) {
    return Response.json({ error: "Unauthorized: Bearer token required" }, { status: 401 });
  }
  // وضع بدون جلسات — ندع الـ transport يرد وفق المواصفة (405)
  return handleWithTransport(req);
}
