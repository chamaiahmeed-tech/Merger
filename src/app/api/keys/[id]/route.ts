import { deleteKey, toKeyDTO, updateKeyStatus } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// تعطيل/تنشيط يدوي
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  if (!body?.status || !["active", "disabled"].includes(body.status)) {
    return Response.json({ error: "قيمة الحالة غير صحيحة — المتاح: active أو disabled" }, { status: 400 });
  }
  const updated = await updateKeyStatus(id, body.status as "active" | "disabled");
  if (!updated) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return Response.json({ key: toKeyDTO(updated) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteKey(id);
  if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return Response.json({ ok: true });
}
