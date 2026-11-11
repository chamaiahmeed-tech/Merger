import { dbHealthy } from "@/lib/turso";
import { modelsInfo } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await dbHealthy();
  const mergerHealthyFlag = ok ? await mergerHealthy() : false;
  return Response.json(
    {
      ok,
      database: ok ? "turso-connected" : "disconnected",
      mcpEndpoint: "/mcp",
      models: modelsInfo(),
      merger: { base: mergerBase(), healthy: mergerHealthyFlag },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { status: ok ? 200 : 503 }
  );
}
