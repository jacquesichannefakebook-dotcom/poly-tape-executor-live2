import {
  dashboardData,
  deleteTradingCredentials,
  saveTradingCredentials,
} from "../../../lib/executor-store";
import { boundedJson, requireOwner } from "../../../lib/owner-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ownerEmail = await requireOwner(request);
    const body = await boundedJson(request);
    await saveTradingCredentials(body, ownerEmail);
    return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const allowed = new Set([
      "ORIGIN_REJECTED", "OWNER_REQUIRED", "INVALID_BODY", "BODY_TOO_LARGE", "SIGNER_KEY_INVALID",
      "ACCOUNT_WALLET_INVALID", "RELAYER_ADDRESS_INVALID", "RELAYER_KEY_INVALID",
      "CLOB_CREDENTIALS_INCOMPLETE", "CREDENTIAL_VAULT_UNAVAILABLE",
    ]);
    const message = allowed.has(candidate) ? candidate : "CREDENTIAL_SAVE_FAILED";
    const status = candidate === "OWNER_REQUIRED" ? 403 : candidate === "CREDENTIAL_VAULT_UNAVAILABLE" ? 503 : 400;
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request) {
  try {
    await requireOwner(request);
    const body = await boundedJson(request);
    if (body.confirm !== "EFFACER") return Response.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
    await deleteTradingCredentials();
    return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const message = candidate === "OWNER_REQUIRED" || candidate === "ORIGIN_REJECTED" ? candidate : "CREDENTIAL_DELETE_FAILED";
    return Response.json({ error: message }, { status: candidate === "OWNER_REQUIRED" ? 403 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
