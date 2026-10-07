import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const temp = await mkdtemp(join(tmpdir(), "openclaw mac test "));
process.env.OPENCLAW_CONFIG_FILE = join(temp,"config/local.json");
process.env.OPENCLAW_UI_DATA_DIR = join(temp,"data");
process.env.OPENCLAW_INSTANCES_FILE = join(temp, "instances.json");
process.env.OPENCLAW_ORACLE_KEY = join(temp, "absent relay key");
process.env.OPENCLAW_ORACLE_HOST = "ubuntu@relay.example";
delete process.env.OPENCLAW_ORACLE_SECONDARY_HOST;
// The status endpoint checks component presence; use isolated marker files so
// the test does not depend on the developer's installed SDK or real Keychain.
process.env.OPENCLAW_PACKAGE_ROOT = join(temp, "sdk");
process.env.OPENCLAW_KEYCHAIN_BIN = join(temp, "keychain-helper");
await mkdir(join(temp, "sdk/dist/plugin-sdk"), { recursive: true });
await writeFile(join(temp, "sdk/dist/plugin-sdk/testing.js"), "");
await writeFile(process.env.OPENCLAW_KEYCHAIN_BIN, "");
const { server, redactText, chineseError, nextBridgePort, relayConfigArgs, enqueue, pairingState, assertRelayAuthorized, gatewayFailureKind, newBridgeMaintenanceSession } = await import("../console/server.mjs");

test("relay requires actual SSH authorization and never disables host verification", async () => {
  await assert.rejects(assertRelayAuthorized(async args => {
    assert.equal(args.at(-1), "true");
    assert.ok(args.includes("IdentitiesOnly=yes"));
    assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
    throw new Error("Permission denied (publickey)");
  }), error => error.code === "RELAY_SETUP_REQUIRED" && /尚未接受/.test(error.message));
  await assertRelayAuthorized(async () => true);
  await assert.rejects(assertRelayAuthorized(async () => {throw Error("REMOTE HOST IDENTIFICATION HAS CHANGED");}), /HOST IDENTIFICATION/);
});

test("pairing without a request ID is never classified as a network outage", () => {
  const state = pairingState({ health_error: "gateway connect failed: GatewayClientRequestError: pairing required" }, "ins_test");
  assert.equal(state.stage, "pairing_required");
  assert.equal(state.online, false);
  assert.equal(state.requestId, undefined);
  assert.equal(pairingState({ health_error: "ECONNREFUSED" }, "ins_test"), null);
  const id = "11111111-2222-3333-4444-555555555555";
  assert.equal(pairingState({ error_code: "PAIRING_REQUIRED", requestId: id }, "ins_test").requestId, id);
});

test.after(async () => { if (server.listening) await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); });

test("empty registry and setup pages work without secrets", async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(base + "/api/instances")).json()).instances, []);
  const local = await (await fetch(base + "/api/local-status")).json();
  assert.equal(local.relayKey, false); assert.equal(local.service, "openclaw-farm-console");
  assert.equal(local.transferMode, "mcp-bridge");
  assert.equal(local.installerSource, "bundled");
  assert.equal(local.r2Verified, false);
  assert.match(local.message, /登记 → MCP → 文件桥 → 安全隧道/);
  for (const path of ["/", "/connections.html", "/app.js", "/connections.js", "/local-status.js"]) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  const invalid = await fetch(base + "/api/connections/register", { method: "POST", body: JSON.stringify({ url: "bad", token: "dummy-long-invalid-credential" }) });
  assert.equal(invalid.status, 500);
  assert.ok((await invalid.json()).error.includes("链接"));
});

test("errors redact credentials and preserve actionable Chinese", () => {
  const value = "sk-openclaw-abcdef0123456789 fb_abcdef01234567890123456789 Bearer private-credential";
  assert.equal(redactText(value), "[REDACTED] [REDACTED] [REDACTED]");
  assert.match(chineseError("FarmError: 登录钥匙串已锁定，请解锁。"), /钥匙串已锁定/);
});

test("relay registration preserves both tunnel ends and remote paths", () => {
  const args = relayConfigArgs("ins_test", 20000);
  const get = key => args[args.indexOf(key) + 1];
  assert.equal(get("--transport"), "ssh_relay");
  assert.equal(get("--relay-host"), "relay.example");
  assert.equal(get("--local-port"), "20000");
  assert.equal(get("--relay-port"), "20000");
  assert.equal(get("--workspace"), "/home/node/.openclaw/workspace");
});

test("concurrent port allocations are distinct and skip occupied ports", async () => {
  const occupied = createServer();
  const owned = await new Promise((resolve, reject) => {
    occupied.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
    occupied.listen(20080, "127.0.0.1", () => resolve(true));
  });
  try {
    const ports = await Promise.all([nextBridgePort("ins_one", {probeRelay:async()=>true}), nextBridgePort("ins_two", {probeRelay:async()=>true})]);
    assert.equal(new Set(ports).size, 2); assert.ok(!ports.includes(20080));
    assert.equal(await nextBridgePort("ins_one", {probeRelay:async()=>true}), ports[0]);
  } finally { if (owned) await new Promise(r => occupied.close(r)); }
});

test("one instance failure does not block another or the next request", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const first = enqueue("one", () => gate.then(() => { throw Error("expected"); }));
  const checked = assert.rejects(first, /expected/);
  assert.equal(await enqueue("two", () => "independent"), "independent");
  const second = enqueue("one", () => "recovered");
  release(); await checked; assert.equal(await second, "recovered");
});


test("Gateway authentication failures are distinct from recoverable transport errors", () => {
  const classify = health_error => gatewayFailureKind({health_error});
  assert.equal(classify("gateway connect failed: unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)"), "token_mismatch");
  assert.equal(classify("token has expired"), "token_expired");
  assert.equal(classify("device_token_mismatch"), "device");
  assert.equal(classify("token configured; gateway closed: 1006 abnormal closure"), "transient");
  assert.equal(classify("connect ECONNREFUSED"), "transient");
  assert.equal(classify("keychain access denied"), "credential_store");
  assert.equal(classify("pairing required"), "pairing");
  assert.equal(classify("token count unavailable"), "unknown");
});


test("every bridge installation gets a fresh session distinct from default and prior jobs", () => {
  const keys = new Set(Array.from({length:100}, () => newBridgeMaintenanceSession("ins_example")));
  assert.equal(keys.size, 100);
  for (const key of keys) {
    assert.match(key, /^agent:main:openclaw-control-ui:filebridge-example-[0-9a-f-]{36}$/);
    assert.notEqual(key, "agent:main:main");
    assert.notEqual(key, "agent:main:openclaw-control-ui:filebridge-example");
  }
  assert.throws(() => newBridgeMaintenanceSession("main"), /实例编号/);
});
