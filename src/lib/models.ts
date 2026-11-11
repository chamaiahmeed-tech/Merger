// سجل الموديلات — الأسماء قابلة للتجاوز بمتغيرات البيئة
export type ProviderId = "kie" | "cometapi";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const env = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

export const MODELS: ModelDef[] = [
  {
    canonical: env(process.env.KIE_IMAGE_MODEL) ?? "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env(process.env.KIE_IMAGE_MODEL) ?? "gpt-image-2-6/flare-text-to-image",
      cometapi: env(process.env.COMETAPI_IMAGE_MODEL) ?? "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: env(process.env.KIE_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env(process.env.KIE_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview",
      cometapi: env(process.env.COMETAPI_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview",
    },
  },
];

// قبول الصيغ البديلة بالنقاط/الشرطات وتوحيدها
export function resolveModel(name: string | undefined): ModelDef | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  for (const m of MODELS) {
    const variants = new Set<string>([m.canonical.toLowerCase(), ...m.aliases.map((a) => a.toLowerCase())]);
    variants.add(m.canonical.toLowerCase().replace(/(\d)\.(\d)/g, "$1-$2"));
    variants.add(m.canonical.toLowerCase().replace(/(\d)-(\d)/g, "$1.$2"));
    if (variants.has(n)) return m;
  }
  return undefined;
}

export function defaultModel(type: MediaType): ModelDef {
  return MODELS.find((m) => m.type === type)!;
}

export function modelsInfo(): { canonical: string; type: MediaType; providers: ProviderId[] }[] {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
