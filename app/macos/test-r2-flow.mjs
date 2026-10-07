import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildPrompt } from "../console/server.mjs";

const source = readFileSync(new URL("../console/public/connections.js", import.meta.url), "utf8");
const progressHelpers = source.slice(0, source.indexOf('const SELECTED_INSTANCE_KEY'));
const accessHelpers = source.slice(source.indexOf('function namedInstanceAccess('), source.indexOf('function syncNamedInstanceProtection('));
const functions = source.slice(source.indexOf("function applyLights()"), source.indexOf("async function registerInstance()"));
function fixture(status, flow = {}) {
  const elements = {};
  const state = { selectedId: "ins_a", instances: [{id:"ins_a",hasCredential:true}],
    statuses: {ins_a:status}, flows: {ins_a:flow} };
  const context = vm.createContext({state, localStorage:{setItem(){}}, SELECTED_INSTANCE_KEY:"id",
    namedAuthorizations:new Set(),namedPermissionAuthorizations:new Set(),
    $: id => elements[id] ||= {classList:{add(){},remove(){}}},
    setStep: (id, step) => (elements[id] ||= {}).step = step,
    renderResult: (message,type) => {elements.result = {message,type};},
    saveConnectionMemory(){}, api: async () => ({statuses:{ins_a:status}})});
  vm.runInContext(progressHelpers + accessHelpers + functions, context);
  return {context,state,elements};
}

test("MCP success advances to bridge setup without marking the bridge online", () => {
  const {context,elements} = fixture({mcp:true,bridge:false});
  vm.runInContext("applyLights(); applySelectedProgress()", context);
  assert.equal(elements.mcpLight.className, "online");
  assert.equal(elements.bridgeLight.className, "");
  assert.equal(elements.stepMcp.step, "done");
  assert.equal(elements.stepBridge.step, "active");
  assert.equal(elements.installBridgeButton.textContent, "一键安装文件桥");
});

test("a bridge setup error remains visible even when MCP is healthy", async () => {
  const original = "本机缺少中继私钥，请导入后再使用文件传输。";
  const {context,state,elements} = fixture({mcp:true,bridge:false}, {type:"error",message:original});
  await vm.runInContext("refreshInstanceStatus('ins_a')", context);
  assert.equal(state.flows.ins_a.message, original);
  assert.equal(state.flows.ins_a.type,"error");
  assert.equal(elements.mcpLight.className,"online");
});

test("connection failure is still visible when MCP itself is down", async () => {
  const {context,state} = fixture({mcp:false,bridge:false}, {type:"error",message:"缺少私钥"});
  await vm.runInContext("refreshInstanceStatus('ins_a')", context);
  assert.equal(state.flows.ins_a.type,"error");
});

test("assistant follows original setup order with one configured installer source", () => {
  const prompt = buildPrompt({id:"ins_a"}, "下载报告", false);
  assert.match(prompt,/登记实例 → 验通 MCP\/Gateway → 通过独立维护会话安装文件桥/);
  assert.match(prompt,/OPENCLAW_FILE_BRIDGE_R2_URL/);
  assert.match(prompt,/openclaw_chat_send/);
  assert.match(prompt,/本条只读/);
  assert.match(prompt,/不得猜测桶名/);
});

test("connection page keeps all four original steps and the install action visible", () => {
  const html = readFileSync(new URL("../console/public/connections.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/<li id="(step\w+)"/g)].map(match => match[1]);
  assert.deepEqual(ids,["stepRegistry","stepMcp","stepBridge","stepTunnel"]);
  assert.ok(!/<details(?:(?!<\/details>)[\s\S])*id="installBridgeButton"/.test(html));
  assert.match(html,/id="installBridgeButton"[^>]*>一键安装文件桥/);
});

test("legacy browser memory keeps durable job IDs and discards stale approvals and health claims", () => {
  const loader = source.slice(source.indexOf("function loadConnectionMemory()"),source.indexOf("const connectionMemory ="));
  const context = vm.createContext({localStorage:{getItem:()=>JSON.stringify({flows:{
    ins_old:{message:"旧版可选文件桥",type:"success"},
    ins_error:{message:"旧版可选文件桥",optionalBridgeError:"SSH 认证缺失",jobStatus:"failed"},
    ins_running:{message:"旧版可选文件桥",jobStatus:"running",jobId:"job-one"},
    ins_pairing:{jobId:"job-pairing",jobStatus:"awaiting_approval",approval:{prompt:"pairing"},message:"旧版可选文件桥"}
  }})}, CONNECTION_MEMORY_KEY:"test"});
  const value=vm.runInContext(loader+"\nloadConnectionMemory()",context);
  assert.equal(value.flows.ins_running.jobId,"job-one");
  assert.equal(value.flows.ins_pairing.jobId,"job-pairing");
  for(const flow of Object.values(value.flows)) {
    assert.equal(flow.jobStatus,"unchecked");
    assert.deepEqual(Object.keys(flow).sort(),["jobId","jobStatus"]);
  }
  assert.equal(value.flows.ins_pairing.approval,undefined);
  assert.equal(JSON.stringify(value.statuses),'{}');
});
