import { installCloudflareScheduler, validateCloudflareInstallerInput } from "../../../lib/cloudflare-installer";
import { boundedJson, requireOwner } from "../../../lib/owner-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireOwner(request);
    const body = await boundedJson(request);
    if (body.confirm !== "INSTALLER") {
      return Response.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const input = validateCloudflareInstallerInput({
      apiToken: body.apiToken,
      accountId: body.accountId,
    });
    const result = await installCloudflareScheduler(input);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const allowed = new Set([
      "ORIGIN_REJECTED", "OWNER_REQUIRED", "INVALID_BODY", "BODY_TOO_LARGE", "CONFIRMATION_REQUIRED",
      "CLOUDFLARE_ACCOUNT_INVALID", "CLOUDFLARE_TOKEN_INVALID", "CLOUDFLARE_TOKEN_REFUSED",
      "CLOUDFLARE_INSTALL_FAILED", "CLOUDFLARE_PROXY_INSTALL_FAILED", "CLOUDFLARE_SCHEDULER_INSTALL_FAILED",
      "CLOUDFLARE_SCHEDULE_INSTALL_FAILED", "CLOUDFLARE_RESPONSE_TOO_LARGE", "CLOUDFLARE_SCHEDULE_NOT_CONFIRMED",
      "CLOUDFLARE_SUBDOMAIN_UNAVAILABLE", "CLOUDFLARE_PROXY_PUBLISH_FAILED", "CLOUDFLARE_PROXY_VERIFY_FAILED",
      "CLOUDFLARE_PROXY_REGION_BLOCKED",
      "SCHEDULER_INSTALLER_NOT_READY",
    ]);
    const message = allowed.has(candidate) ? candidate : "CLOUDFLARE_INSTALL_FAILED";
    const status = candidate === "OWNER_REQUIRED" || candidate === "ORIGIN_REJECTED" ? 403
      : candidate === "SCHEDULER_INSTALLER_NOT_READY" ? 503 : 400;
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
