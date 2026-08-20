import { runtime } from "./executor-store";

const MAX_BODY_BYTES = 16_384;

async function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ (rightBytes[index] || 0);
  return difference === 0;
}

export async function requireOwner(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("ORIGIN_REJECTED");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || "";
  const expected = runtime().POLY_TAPE_OWNER_EMAIL?.trim().toLowerCase() || "owner@poly-tape.local";
  if (!email || !expected || !await sameSecret(email, expected)) throw new Error("OWNER_REQUIRED");
  return email;
}

export async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error("INVALID_BODY");
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_BODY");
  return parsed as Record<string, unknown>;
}
