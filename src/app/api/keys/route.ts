import { addKey, DuplicateKeyError, listKeys, toKeyDTO } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// القائمة الكاملة مع إخفاء المفاتيح دائمًا — لا يُعاد المفتاح الكامل في أي استجابة
export async function GET() {
  const keys = await listKeys();
  return Response.json({ keys });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { provider?: string; apiKey?: string; label?: string }
    | null;
  if (!body?.provider || !body.apiKey) {
    return Response.json({ error: "صيغة الطلب غير صحيحة — المطلوب: provider و apiKey" }, { status: 400 });
  }
  if (!["kie", "cometapi"].includes(body.provider)) {
    return Response.json({ error: "المزود غير مدعوم — القيم المتاحة: kie أو cometapi" }, { status: 400 });
  }
  if (body.apiKey.trim().length < 8) {
    return Response.json({ error: "المفتاح قصير جدًا — تأكد من نسخه كاملًا" }, { status: 400 });
  }
  try {
    const key = await addKey(body.provider, body.apiKey.trim(), (body.label || "").trim());
    return Response.json({ key: toKeyDTO(key) }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: err instanceof Error ? err.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
