import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {bridgePortClaims,exclusivelyClaimed} from '../console/bridge-port-claims.mjs';
import {existingBridgeProbeCommand,parseExistingBridgeProbe,shouldRenewExistingBridgeProbe} from '../console/bridge-existing-probe.mjs';
import {publicJob} from '../console/connection-job-store.mjs';
import {executionCommandFingerprint,executionProbeCommand,parseExecutionProbe} from '../console/bridge-execution-probe.mjs';
import {pythonBin,assertShellSyntax,bashSyntaxSkip} from './portable-test-tools.mjs';
test('restart retains queued and blocked task port claims before registry configuration',()=>{
 const registry={instances:{ins_a:{file_bridge:{base_url:'http://127.0.0.1:20071',relay_port:20071}}}};
 const jobs=[{instanceId:'ins_b',port:20071,status:'blocked'},{instanceId:'ins_c',port:20070,status:'queued'}];
 const claims=bridgePortClaims(registry,jobs,new Map([['ins_d',20069]]));
 assert.equal(exclusivelyClaimed(claims,'ins_a',20071),false);assert.equal(exclusivelyClaimed(claims,'ins_b',20071),false);assert.deepEqual([...claims.keys()],[20071,20070,20069]);
 assert.equal(exclusivelyClaimed(claims,'ins_c',20070),true);
});
test('completed historical jobs do not retain bridge ports',()=>{
 const claims=bridgePortClaims({instances:{}},[{instanceId:'ins_old',port:20053,status:'complete'},{instanceId:'ins_live',port:20054,status:'blocked'}]);
 assert.equal(claims.has(20053),false);assert.equal(exclusivelyClaimed(claims,'ins_live',20054),true);
});
test('probe contains no local credential and proves only matching actual execution',async t=>{
 const tag='a'.repeat(32),token='fb_'+'b'.repeat(64),key='ssh-ed25519 '+'A'.repeat(68)+' node@pod-ins-example',command=existingBridgeProbeCommand(tag),digest=createHash('sha256').update(command).digest('hex');
 assert.ok(command.includes("'ssh-keygen','-y'"));assert.ok(!command.includes('openclaw_tunnel.pub'));
 assert.ok(!command.includes(token));assert.equal(command.split('\n').length,3);assert.equal(spawnSync(pythonBin,['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:command.split('\n')[1],encoding:'utf8'}).status,0);
 await t.test('generated Linux probe shell syntax',{skip:bashSyntaxSkip},()=>assertShellSyntax(command));
 const payload={stored:[createHash('sha256').update(token).digest('hex')],healthy:false,publicKey:key};
 const h={messages:[{role:'user',content:command},{role:'toolResult',toolName:'exec',content:`BRIDGE_PROBE_${tag} ${JSON.stringify(payload)}`},{role:'assistant',content:'done',stopReason:'stop'}]};
 assert.deepEqual(parseExistingBridgeProbe(h,{tag,token,commandDigest:digest}),{publicKey:key,serviceHealthy:false,credentialMatches:true});
 const withoutKey=structuredClone(h);withoutKey.messages[1].content=`BRIDGE_PROBE_${tag} ${JSON.stringify({...payload,publicKey:''})}`;
 assert.deepEqual(parseExistingBridgeProbe(withoutKey,{tag,token,commandDigest:digest}),{publicKey:'',serviceHealthy:false,credentialMatches:true});
 assert.equal(parseExistingBridgeProbe(h,{tag,token:'other',commandDigest:digest}).credentialMatches,false);
 for(const change of [x=>x.messages[0].content+='wrong',x=>x.messages[1].role='assistant',x=>x.messages[2].stopReason='toolUse']){const copy=structuredClone(h);change(copy);assert.equal(parseExistingBridgeProbe(copy,{tag,token,commandDigest:digest}),null);}
});
test('probe tracking survives restart without persisting any secret or command',()=>{
 const j=publicJob({id:'id',routeProbeSession:'main',routeProbeTag:'a'.repeat(32),routeProbeRunId:'run',token:'secret',command:'private'});
 assert.equal(j.routeProbeRunId,'run');assert.equal(j.token,undefined);assert.equal(j.command,undefined);
});
test('an active read-only probe keeps its session while a delayed remote result arrives',()=>{
 const now=1000000,job={routeProbeVersion:6,routeProbeSession:'agent:main:probe',routeProbeTag:'a'.repeat(32),routeProbeStartedAt:now};
 assert.equal(shouldRenewExistingBridgeProbe(job,now+60000),false);
 assert.equal(shouldRenewExistingBridgeProbe(job,now+119999),false);
 assert.equal(shouldRenewExistingBridgeProbe(job,now+120000),true);
});
test('expired execution probe contains only a command fingerprint and requires actual complete zero-match result',()=>{
 const secretCommand="echo SECRET_FIXTURE_ONLY",tag='b'.repeat(32),digest=executionCommandFingerprint(secretCommand),command=executionProbeCommand(digest,tag);
 assert.ok(!command.includes(secretCommand));assert.ok(command.includes(digest));assert.equal(spawnSync(pythonBin,['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:command.split('\n')[1],encoding:'utf8'}).status,0);
 const result={requestFound:true,turnSettled:true,executionText:`EXECUTION_PROBE_${tag} {"checked":5,"active":0}`};
 assert.deepEqual(parseExecutionProbe(result,tag),{active:0});
 assert.equal(parseExecutionProbe({...result,turnSettled:false},tag),null);assert.equal(parseExecutionProbe({...result,requestFound:false},tag),null);assert.equal(parseExecutionProbe({...result,executionText:result.executionText.replace('"checked":5','"checked":0')},tag),null);
});
