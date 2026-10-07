import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || join(root, "runtime/node/node_modules/openclaw");
const requireSdkDependency = createRequire(join(packageRoot, "package.json"));
const { WebSocketServer } = requireSdkDependency("ws");
const temp = await mkdtemp(join(tmpdir(), "openclaw SDK test "));
const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise(r => gateway.once("listening", r));
const calls = [];
gateway.on("connection", socket => {
  socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "local-test-nonce", ts: Date.now() } }));
  socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    let payload;
    if (request.method === "connect") {
      assert.equal(request.params.auth.token, "dummy-loopback-test-token");
      payload = { type: "hello-ok", protocol: 3, server: { version: "2026.4.2", connId: "test" },
        features: { methods: ["health", "status", "sessions.list", "chat.send"], events: [] }, snapshot: {},
        policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 } };
    } else {
      calls.push(request.method);
      payload = { ok: true, method: request.method, params: request.params };
    }
    socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
  });
});
try {
  for (const method of ["health", "status", "sessions.list", "chat.send"]) {
    const request = { method, timeoutMs: 3000, params: method === "chat.send" ? { sessionKey: "test-only", message: "local fixture", idempotencyKey: "test-1" } : {} };
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(root, "app/openclaw-farm/scripts/gateway_client.mjs")], {
        env: { ...process.env, OPENCLAW_PACKAGE_ROOT: packageRoot,
          OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${gateway.address().port}`,
          OPENCLAW_GATEWAY_TOKEN: "dummy-loopback-test-token", OPENCLAW_STATE_DIR: temp,
          OPENCLAW_CONFIG_PATH: join(temp, "config.json") }, stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
      child.on("error", reject);
      const timer = setTimeout(() => { child.kill(); reject(Error("SDK fixture timed out")); }, 15000);
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolveResult(JSON.parse(stdout)) : reject(Error(stderr)); });
      child.stdin.end(JSON.stringify(request));
    });
    assert.equal(result.method, method);
  }
  assert.deepEqual(calls, ["health", "status", "sessions.list", "chat.send"]);
  console.log("Official SDK loopback: handshake + health/status/sessions.list/chat.send passed");
} finally {
  for (const socket of gateway.clients) socket.terminate();
  await new Promise(r => gateway.close(r));
  await rm(temp, { recursive: true, force: true });
}
