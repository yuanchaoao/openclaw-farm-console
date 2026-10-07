import {bridgeInstallSteps} from '../console/maintenance-command.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import vm from 'node:vm';
import {assertShellSyntax,bashSyntaxSkip} from './portable-test-tools.mjs';
import {bridgeProgramInstall as realBridgeProgramInstall} from '../console/bridge-installer.mjs';
import {sendMaintenanceRequest} from '../console/maintenance-send.mjs';
import {approveMaintenanceExec} from '../console/exec-approval.mjs';
import {checkBridgeWithRecovery} from '../console/bridge-health-recovery.mjs';
import {waitForMaintenance,parseBridgeInstallResult,maintenanceMarkerPresent,maintenanceRequestDigest} from '../console/maintenance-results.mjs';
import {configureBridgeCommand} from '../console/remote-settings.mjs';
import {bridgeProcessStopSteps} from '../console/bridge-auth-repair.mjs';
import {validateBridgeOperations} from '../console/bridge-validation.mjs';

const instanceId='ins_fixture';
const publicKey='ssh-ed25519 '+'A'.repeat(68)+' openclaw-tunnel';
const body={instanceId,confirm:true,allowSharedWorkspace:true,enableDelete:true};
const message=(role,text)=>({role,content:[{type:'text',text}]});
const source=await readFile(new URL('../console/server.mjs',import.meta.url),'utf8');
const start=source.indexOf('function newBridgeMaintenanceSession(');
const end=source.indexOf('\nconst jobStore',start);
assert.ok(start>=0 && end>start);

function fixture(options={}) {
  const events=[],sends=[],waits=[],progress=[],authorizations=[],sessions=[],files=new Map();
  let current=null,healthReads=0,clock=0;
  const context={
    randomUUID,createHash,bridgeInstallSteps,maintenanceRequestDigest,checkBridgeWithRecovery,configureBridgeCommand,bridgeProcessStopSteps,
    process:{env:{OPENCLAW_MAINTENANCE_MODEL:options.maintenanceModel || ''}},
    jobStore:{save:async()=>{}},
    readBridgeCredential:async()=>"fb_"+"a".repeat(64),
    validateBridgeOperations:(id,enableDelete)=>validateBridgeOperations(context.runFarmCommand,id,enableDelete),
    readInstances:async()=>[{id:instanceId,hasCredential:true,fileBridge:options.configured?{transport:'ssh_relay'}:null}],
    repairExistingBridgeRoute:async job=>{events.push('verified-route-recovery');job.result={instanceId,stage:'complete',capabilities:{read:true,write:true,delete:true}};return true;},
    checkMcpDirect:async input=>{
      events.push('mcp-check');assert.equal(input.instanceId,instanceId);
      if(options.mcpError)throw options.mcpError;
      return options.mcpResult || {online:true};
    },
    assertRelayReady:async()=>events.push('relay-ready'),
    assertRelayAuthorized:async()=>events.push('relay-authorized'),
    preferredBridgePort:async()=>19911,
    bridgeProgramInstall:async variable=>{
      events.push('installer-generated');assert.equal(variable,'D');
      return realBridgeProgramInstall(variable);
    },
    sendMaintenanceRequest,approveMaintenanceExec,parseBridgeInstallResult,maintenanceMarkerPresent,
    shellSingleQuote:value=>`'${value}'`,
    RELAY_DESTINATION:'operator@relay.example.test',RELAY_KEY:'/tmp/offline-key',
    setupConfig:{relay:{user:'operator',sshPort:22022},bridge:{podPort:18081,workspace:'/home/node/.openclaw/workspace'}},
    checkOracleBridgeListener:async()=>{events.push('relay-probe');return options.listener || 'absent';},
    requireOracleBridgeListener:async()=>{events.push('relay-health');assert.ok(events.includes('tunnel-ready') || options.listener==='healthy');},
    chineseError:error=>error.message,
    setTimeout:callback=>{callback();return 0;},
    authorizeBridge:async authorization=>{
      assert.ok(events.includes('install-ready'));
      events.push('oracle-authorize');authorizations.push(authorization);
      assert.equal(authorization.publicKey,publicKey);
    },
    runFarmCommand:async (args,stdin='')=>{
      if(args[0]==='bridge-health') {
        if(healthReads++===0) {
          events.push('bridge-preflight');
          if(options.healthy)return {ok:true,capabilities:{read:true,write:true,delete:true}};
          if(options.preflightError)throw options.preflightError;
          throw Error('fixture: bridge has not been configured');
        }
        assert.ok(events.includes('tunnel-ready') || options.listener==='healthy');
        events.push('bridge-health');
        return {ok:true,capabilities:{read:true,write:true,delete:options.healthDelete!==false}};
      }
      if(args[0]==='bridge-configure') {
        assert.ok(events.includes('relay-health'));
        events.push('bridge-configure');return {};
      }
      if(args[0]==='file-list') {
        events.push('file-list');
        assert.equal(args[1],instanceId);assert.equal(args[2],'.');
        if(options.listError)throw Error('fixture: directory request failed');
        return {entries:[]};
      }
      if(args[0]==='file-write') {events.push('file-write');files.set(args[2],stdin);return {};}
      if(args[0]==='file-read') {events.push('file-read');if(options.readError)throw Error('fixture: file read failed');return JSON.parse(files.get(args[2]));}
      if(args[0]==='file-stat') {events.push('file-stat');return args[2]==='.'?{stat:{type:'dir'}}:{stat:{sha256:createHash('sha256').update(files.get(args[2])).digest('hex')}};}
      if(args[0]==='file-delete') {events.push('file-delete');assert.equal(args[args.indexOf('--expected-sha256')+1],createHash('sha256').update(files.get(args[2])).digest('hex'));files.delete(args[2]);return {};}
      assert.equal(args[0],'call');assert.equal(args[1],instanceId);
      const method=args[2],params=JSON.parse(args[args.indexOf('--params-json')+1]);
      if(method==='sessions.create') {sessions.push(params);events.push('session-created');return {sessionKey:params.key};}
      if(method==='agent.wait')return {runId:params.runId,status:current?.approved?'ok':'timeout'};
      if(method==='chat.send') {
        const kind=params.idempotencyKey.startsWith('bridge-install-')?'install':'tunnel';
        events.push(`${kind}-send`);sends.push(params);
        if(options.sendFailureAt===kind)return options.sendFailure || {runId:'wrong-task',status:'started'};
        current={kind,params,tag:params.message.match(/维护任务编号：([0-9a-f]{32})/)[1],approvalId:randomUUID(),approved:false,reads:0};
        events.push(`${kind}-ack`);
        return {runId:params.idempotencyKey,status:'started'};
      }
      if(method==='exec.approval.resolve') {
        assert.equal(params.id,current.approvalId);
        assert.equal(params.decision,'allow-once');
        current.approved=true;events.push(`${current.kind}-approved`);
        return {ok:true};
      }
      if(method==='chat.history') {
        assert.equal(params.sessionKey,current.params.sessionKey);
        assert.ok(++current.reads<=3,'the real waiter must resolve the fixture promptly');
        const history=[message('user',current.params.message)];
        if(!current.approved) {
          history.push({...message('toolResult','Approval required.'),toolName:'exec',details:{
            status:'approval-pending',approvalId:current.approvalId,
            command:current.params.message.slice(current.params.message.indexOf('set -eu\n')),
            host:'gateway',allowedDecisions:['allow-once'],expiresAtMs:Date.now()+600_000,
          }});
        } else {
          const failed=options.executionFailureAt===current.kind;
          const partial=current.kind==='install' && !current.params.message.includes('_INSTALL_READY');
          const step=current.params.idempotencyKey.match(/-step-(\d+)-attempt-\d+$/)?.[1];
          const output=partial ? `STAGED_${step}` : current.kind==='install'
            ? `OPENCLAW_${current.tag}_PUBKEY_BEGIN ${publicKey} OPENCLAW_${current.tag}_PUBKEY_END OPENCLAW_${current.tag}_INSTALL_READY`
            : `OPENCLAW_${current.tag}_TUNNEL_READY`;
          history.push(message('user',`An async command the user already approved has completed.\nExec finished (${current.approvalId}, code ${failed?1:0}) :: ${output}\nContinue the task if needed`));
          history.push({...message('assistant','complete'),stopReason:'stop'});
          if(!failed && !partial)events.push(`${current.kind}-ready`);
        }
        return {messages:history};
      }
      assert.fail(`unexpected offline method: ${method}`);
    },
    waitForMaintenance:async config=>{
      const kind=current.kind;
      assert.ok(events.includes(`${kind}-ack`),'no result polling without an acknowledgement');
      waits.push(config);events.push(`${kind}-wait`);
      return waitForMaintenance({...config,now:()=>clock,sleep:async ms=>{clock+=ms;},onPause:async()=>assert.fail('offline flow should not pause')});
    },
  };
  const install=vm.runInNewContext(`${source.slice(start,end)}\ninstallBridgeViaMcp`,context);
  return {events,sends,waits,progress,authorizations,sessions,files,run:async(job=null)=>{
    const result=await install(body,text=>progress.push(text),null,job);
    events.push('returned');return result;
  }};
}

test('one click checks MCP, installs in a new main agent session, approves via MCP, and verifies tunnel, health and directory',async t=>{
  const value=fixture();
  const result=await value.run();
  assert.equal(result.stage,'complete');
  assert.ok(value.sends.length>2);
  const install=value.sends[0],tunnel=value.sends.at(-1);
  assert.match(install.sessionKey,/^agent:main:openclaw-control-ui:filebridge-fixture-[0-9a-f-]{36}$/);
  assert.equal(install.sessionKey,tunnel.sessionKey);
  assert.notEqual(install.sessionKey,'agent:main:main');
  assert.equal(install.deliver,false);
  assert.notEqual(install.idempotencyKey,tunnel.idempotencyKey);
  assert.match(tunnel.message,/-R localhost:19911:127\.0\.0\.1:18081/);
  assert.match(tunnel.message,/ssh -p 22022 /);
  const expected=['mcp-check','session-created','installer-generated','install-send','install-ack','install-wait','install-approved','install-ready','oracle-authorize','tunnel-send','tunnel-ack','tunnel-wait','tunnel-approved','tunnel-ready','relay-health','bridge-configure','bridge-health','file-list','file-write','file-read','file-stat','file-delete','returned'];
  for(let index=1;index<expected.length;index++)assert.ok(value.events.indexOf(expected[index-1])<value.events.indexOf(expected[index]),expected.join(' → '));
  assert.equal(value.waits.length,value.sends.length);
  assert.ok(value.waits.every(wait=>wait.sessionKey===install.sessionKey));
  assert.equal(value.authorizations.length,1);
  assert.equal(value.sessions[0].agentId,'main');assert.equal(Object.hasOwn(value.sessions[0],'model'),false);assert.equal(value.files.size,0);
  assert.ok(!JSON.stringify({result,progress:value.progress}).includes(value.authorizations[0].token));
  await t.test('every generated Linux installation and tunnel phase has valid shell syntax',{skip:bashSyntaxSkip},()=>{
    for(const sent of value.sends)assertShellSyntax(sent.message.slice(sent.message.indexOf('set -eu\n')));
  });
});

test('existing healthy bridges reuse without sending maintenance or touching relay authorization',async()=>{
 const value=fixture({healthy:true,configured:true});
 assert.equal((await value.run({})).stage,'complete');assert.equal(value.sends.length,0);assert.equal(value.authorizations.length,0);
 assert.ok(!value.events.includes('installer-generated'));assert.ok(value.events.includes('file-list'));
});

test('new UI jobs use the proven fingerprint and route recovery for HTTP 401, not credential replacement',async()=>{
 const value=fixture({configured:true,preflightError:Error('文件桥 HTTP 401')});
 assert.equal((await value.run({instanceId})).stage,'complete');
 assert.ok(value.events.includes('verified-route-recovery'));assert.equal(value.sends.length,0);
 assert.ok(!value.events.includes('installer-generated'));
});

test('separate new installations use separate sessions on the same main agent',async()=>{
  const first=fixture(),second=fixture();
  await first.run();await second.run();
  assert.notEqual(first.sends[0].sessionKey,second.sends[0].sessionKey);
});

test('pending MCP pairing or MCP failure sends no install or relay change',async()=>{
  const pairing={online:false,stage:'pairing_required',requestId:randomUUID()};
  const pending=fixture({mcpResult:pairing});
  assert.equal(await pending.run(),pairing);
  assert.equal(pending.sends.length,0);assert.equal(pending.waits.length,0);
  assert.ok(!pending.events.includes('installer-generated'));assert.ok(!pending.events.includes('relay-ready'));
  const rejected=fixture({mcpError:Error('fixture: wrong Gateway Token')});
  await assert.rejects(rejected.run(),/wrong Gateway Token/);
  assert.equal(rejected.sends.length,0);assert.equal(rejected.authorizations.length,0);
});

test('missing or rejected install acknowledgement does not start waiting or authorize Oracle',async()=>{
  for(const sendFailure of [{runId:'another-task',status:'started'},{ok:false,error:'token_mismatch'},{}]) {
    const value=fixture({sendFailureAt:'install',sendFailure});
    await assert.rejects(value.run(),error=>error.code.startsWith('MAINTENANCE_SEND_'));
    assert.equal(value.sends.length,1);assert.equal(value.waits.length,0);assert.equal(value.authorizations.length,0);
    assert.ok(!value.progress.some(text=>text.startsWith('安装任务已发送')));
  }
});

test('a rejected tunnel acknowledgement does not wait for the tunnel or report complete',async()=>{
  const value=fixture({sendFailureAt:'tunnel'});
  await assert.rejects(value.run(),error=>error.code==='MAINTENANCE_SEND_ACK');
  assert.equal(value.waits.length,value.sends.length-1);
  assert.ok(!value.events.includes('tunnel-wait'));
  assert.ok(!value.events.includes('bridge-configure'));
});

test('a failed remote tunnel command cannot pass even when its text includes a ready marker',async()=>{
  const value=fixture({executionFailureAt:'tunnel'});
  await assert.rejects(value.run(),error=>error.code==='MAINTENANCE_EXEC_FAILED');
  assert.ok(!value.events.includes('bridge-configure'));
  assert.ok(!value.events.includes('file-list'));
});

test('a missing required capability or failed unique-file read prevents completion',async()=>{
  const limited=fixture({healthDelete:false});
  await assert.rejects(limited.run(),/验通失败/);
  assert.equal(limited.events.filter(event=>event==='bridge-health').length,3);
  assert.ok(!limited.events.includes('file-list'));
  const unreadable=fixture({readError:true});
  await assert.rejects(unreadable.run(),/file read failed/);
  assert.equal(unreadable.events.filter(event=>event==='file-read').length,1);
  assert.ok(unreadable.events.includes('file-delete'));assert.equal(unreadable.files.size,0);
  assert.ok(!unreadable.events.includes('returned'));
});

test('an optional deployment maintenance model is applied only to the independent session',async()=>{
  const value=fixture({maintenanceModel:'example/tool-capable'});await value.run();assert.equal(value.sessions[0].model,'example/tool-capable');
});

test('a healthy reverse listener skips another tunnel while proving actual local file operations',async()=>{
  const value=fixture({listener:'healthy'});await value.run();assert.equal(value.sends.some(send=>send.idempotencyKey.startsWith('bridge-tunnel-')),false);assert.ok(value.events.includes('relay-health'));assert.ok(value.events.includes('file-delete'));
});
