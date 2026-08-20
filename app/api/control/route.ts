import {
  database,
  dashboardData,
  getState,
  getTradingAccountStatus,
  recordTradingApprovals,
  recordTradingAuthFailure,
  recordTradingConnection,
} from "../../../lib/executor-store";
import { boundedJson, requireOwner } from "../../../lib/owner-auth";
import { prepareTradingApprovals, verifyTradingConnection } from "../../../lib/polymarket";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireOwner(request);
    const body = await boundedJson(request) as { action?: string; confirm?: string };
    const action = String(body.action || "");
    await getState();
    const db = database();
    const now = Math.floor(Date.now() / 1000);
    if (action === "pause") {
      await db.prepare("UPDATE executor_state SET mode = 'PAUSED', armed = 0, updated_at = ? WHERE key = 'pilot'").bind(now).run();
    } else if (action === "paper") {
      await db.prepare("UPDATE executor_state SET mode = 'PAPER', armed = 0, updated_at = ? WHERE key = 'pilot'").bind(now).run();
    } else if (action === "verify-account") {
      try {
        const details = await verifyTradingConnection();
        await recordTradingConnection(details);
      } catch (error) {
        await recordTradingAuthFailure("AUTHENTICATION_FAILED");
        throw error;
      }
    } else if (action === "prepare-approvals") {
      if (body.confirm !== "AUTORISER") return Response.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
      const status = await getTradingAccountStatus();
      if (!status.account_verified_at) return Response.json({ error: "ACCOUNT_VERIFICATION_REQUIRED" }, { status: 409 });
      try {
        const details = await prepareTradingApprovals();
        await recordTradingApprovals(details);
      } catch (error) {
        await recordTradingAuthFailure("APPROVALS_FAILED");
        throw error;
      }
    } else if (action === "arm-live") {
      if (body.confirm !== "ARMER") return Response.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
      const current = await dashboardData();
      if (!current.liveReady) return Response.json({ error: "LIVE_CONFIGURATION_INCOMPLETE" }, { status: 409 });
      await db.prepare("UPDATE executor_state SET mode = 'LIVE', armed = 1, updated_at = ? WHERE key = 'pilot'").bind(now).run();
    } else {
      return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
    }
    return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const allowed = new Set([
      "LIVE_CONFIGURATION_INCOMPLETE", "SIGNER_KEY_INVALID", "ACCOUNT_WALLET_INVALID", "RELAYER_ADDRESS_INVALID",
      "ACCOUNT_WALLET_MISMATCH", "RELAYER_SIGNER_MISMATCH", "ACCOUNT_VERIFICATION_REQUIRED",
      "ORIGIN_REJECTED", "OWNER_REQUIRED", "INVALID_BODY", "BODY_TOO_LARGE",
    ]);
    const candidate = error instanceof Error ? error.message : "";
    const message = allowed.has(candidate) ? candidate : "LIVE_AUTHENTICATION_FAILED";
    const status = candidate === "OWNER_REQUIRED" || candidate === "ORIGIN_REJECTED" ? 403 : 500;
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
