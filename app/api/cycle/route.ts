import { runExecutionCycle } from "../../../lib/executor-engine";
import { dashboardData } from "../../../lib/executor-store";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const cycle = await runExecutionCycle("api");
    return Response.json({ cycle, dashboard: await dashboardData() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CYCLE_UNAVAILABLE";
    return Response.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET() {
  return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
}
