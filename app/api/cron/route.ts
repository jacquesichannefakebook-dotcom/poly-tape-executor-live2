import { runExecutionCycle } from "../../../lib/executor-engine";
import { effectiveCronSecret } from "../../../lib/executor-store";

export const dynamic = "force-dynamic";

function authorized(header: string | null, expected: string) {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = new TextEncoder().encode(header.slice(7));
  const wanted = new TextEncoder().encode(expected);
  let difference = provided.byteLength ^ wanted.byteLength;
  for (let index = 0; index < provided.byteLength; index += 1) difference |= provided[index] ^ (wanted[index] || 0);
  return difference === 0;
}

export async function POST(request: Request) {
  const secret = await effectiveCronSecret();
  if (!secret) return Response.json({ error: "SCHEDULER_NOT_CONFIGURED" }, { status: 503 });
  if (!authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const cycle = await runExecutionCycle("scheduled");
  return Response.json({ cycle }, { headers: { "Cache-Control": "no-store" } });
}
