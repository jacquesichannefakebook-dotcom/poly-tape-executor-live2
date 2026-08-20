async function runCycle(env, source) {
  const startedAt = Date.now();
  const response = await fetch(env.EXECUTOR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      "OAI-Sites-Authorization": `Bearer ${env.SITES_BYPASS_TOKEN}`,
      "User-Agent": "PolyTapeScheduler/1.0",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (response.body) await response.body.cancel();
  const event = {
    event: "executor_cycle",
    source,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(event));
  if (!response.ok) throw new Error(`EXECUTOR_HTTP_${response.status}`);
}

const schedulerWorker = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ service: "poly-tape-scheduler", status: "ready" }, {
      headers: { "Cache-Control": "no-store" },
    });
  },

  async scheduled(controller, env) {
    try {
      await runCycle(env, controller.cron);
    } catch (error) {
      console.error(JSON.stringify({
        event: "executor_cycle_error",
        source: controller.cron,
        message: error instanceof Error ? error.message : "SCHEDULER_ERROR",
      }));
      throw error;
    }
  },
};

export default schedulerWorker;
