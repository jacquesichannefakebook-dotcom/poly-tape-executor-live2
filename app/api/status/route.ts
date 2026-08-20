import { dashboardData } from "../../../lib/executor-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "EXECUTOR_UNAVAILABLE";
    return Response.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
