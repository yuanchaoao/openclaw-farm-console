#!/usr/bin/env node

import { loadGatewaySdk } from "./load-gateway-sdk.mjs";
import { readPairingDetails } from "./pairing-details.mjs";


const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const FULL_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
];


async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("request exceeds 24 MiB");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}


async function main() {
  const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT;
  const { callGateway } = await loadGatewaySdk(packageRoot);
  if (process.argv.includes("--check-sdk")) {
    process.stdout.write(JSON.stringify({ ok: true, callGateway: true }));
    return;
  }

  const request = await readInput();
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("request must be a JSON object");
  }
  if (typeof request.method !== "string" || request.method.length === 0) {
    throw new Error("request method is missing");
  }
  if (request.expectFinal !== undefined && typeof request.expectFinal !== "boolean") {
    throw new Error("expectFinal must be a boolean");
  }
  const expectFinal = request.expectFinal === true;
  if (expectFinal && request.method !== "agent") {
    throw new Error("expectFinal is restricted to agent requests");
  }
  const result = await callGateway({
    url: process.env.OPENCLAW_GATEWAY_URL,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    method: request.method,
    params: request.params ?? {},
    timeoutMs: request.timeoutMs,
    expectFinal,
    scopes: FULL_OPERATOR_SCOPES,
  });
  process.stdout.write(JSON.stringify(result));
}


main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/pairing required|scope upgrade pending approval/i.test(message)) {
    let details = {};
    try { details = await readPairingDetails(process.env.OPENCLAW_PACKAGE_ROOT, FULL_OPERATOR_SCOPES); } catch { /* pairing remains actionable without a request ID */ }
    process.stderr.write(JSON.stringify({ code: "PAIRING_REQUIRED", message: "pairing required", ...details }) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
  process.exitCode = 1;
});
