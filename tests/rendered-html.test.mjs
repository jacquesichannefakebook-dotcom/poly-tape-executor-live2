import assert from "node:assert/strict";
import test from "node:test";

test("renders Poly Tape Executor metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  assert.equal(typeof worker.scheduled, "function");

  const env = {
    POLY_TAPE_ADMIN_SECRET: "test-secret-longer-than-16-characters",
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  };
  const redirect = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    ctx,
  );
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), "/_poly-tape/login");

  const response = await worker.fetch(
    new Request("http://localhost/_poly-tape/login", {
      headers: { accept: "text/html" },
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>Poly Tape Executor<\/title>/i);
  assert.doesNotMatch(html, /codex-preview/i);
});
