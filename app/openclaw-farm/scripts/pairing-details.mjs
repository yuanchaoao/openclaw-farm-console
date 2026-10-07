import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The SDK's callGateway wrapper turns structured connect errors into a close
// message. Retrieve only pairing metadata using the same existing device and
// scopes. This never approves a device or issues a remote RPC.
export async function readPairingDetails(packageRoot, scopes) {
  const state = process.env.OPENCLAW_STATE_DIR;
  if (!state) return {};
  let identity;
  try { identity = JSON.parse(fs.readFileSync(path.join(state, "identity", "device.json"), "utf8")); }
  catch { return {}; }
  const deviceId = /^[a-f0-9]{64}$/i.test(identity.deviceId || "") ? identity.deviceId : undefined;
  const { GatewayClient } = await import(pathToFileURL(path.join(packageRoot, "dist", "plugin-sdk", "gateway-runtime.js")));
  return new Promise((resolve) => {
    let done = false;
    const finish = (details = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.stop();
      const requestId = typeof details.requestId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(details.requestId) ? details.requestId : undefined;
      resolve({ deviceId, ...(requestId ? { requestId } : {}) });
    };
    const client = new GatewayClient({
      url: process.env.OPENCLAW_GATEWAY_URL,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      clientName: "cli", mode: "cli", role: "operator", scopes,
      deviceIdentity: identity,
      onConnectError: (error) => finish(error?.details || {}),
      onHelloOk: () => finish(),
      onClose: () => finish(),
    });
    const timer = setTimeout(() => finish(), 4000);
    client.start();
  });
}
