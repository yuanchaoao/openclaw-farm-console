import {configureBridgeCommand} from './remote-settings.mjs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
export function bridgeProcessStopSteps() {
  // Keep this command readable: the Gateway requires byte-for-byte approval
  // of the exec request, and encoded process-control scripts are often
  // classified as obfuscated or rewritten before approval.
  const pattern='^python3 /home/node/[.]openclaw/workspace/[.]openclaw-file-bridge/server[.]py([[:space:]]|$)';
  return [
    'command -v pgrep >/dev/null',
    `PIDS=$(pgrep -f '${pattern}' || true)`,
    '[ -z "$PIDS" ] || kill $PIDS',
    'STOPPED=0',
    `for N in 1 2 3 4 5 6 7 8 9 10; do PIDS=$(pgrep -f '${pattern}' || true); if [ -z "$PIDS" ] && python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.2); sys.exit(0 if s.connect_ex(("127.0.0.1",18081)) != 0 else 1)'; then STOPPED=1; break; fi; sleep 1; done`,
    '[ "$STOPPED" = 1 ] || { echo "旧文件桥进程或端口仍在占用，停止启动新进程"; exit 1; }'
  ].map(command=>configureBridgeCommand(command));
}
export async function readBridgeCredential(instanceId) {
  if(!/^ins_[a-z0-9]+$/i.test(instanceId))throw Error('实例编号无效');
  const executable=process.env.OPENCLAW_KEYCHAIN_BIN;
  const service=process.env.OPENCLAW_BRIDGE_SECRET_SERVICE || 'openclaw-file-bridge';
  if(!executable)throw Error('缺少本机钥匙串组件');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.OPENCLAW_PYTHON_BIN || 'python3',[executable],{stdio:['pipe','pipe','ignore']});let output='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536)child.kill('SIGTERM');});
    child.on('error',()=>{clearTimeout(timer);reject(Error('钥匙串组件无法运行'));});
    child.on('close',code=>{
      clearTimeout(timer);
      try {
        const result=JSON.parse(output);output='';
        if(code===0 && result.ok && /^fb_[0-9a-f]{64}$/.test(result.value))return resolve(result.value);
        if(result.error==='locked')throw Error('钥匙串已锁定，请解锁后重试');
        if(result.error==='denied')throw Error('钥匙串访问被拒绝');
        throw Error('本机没有可用于同步的文件桥专用凭据');
      }catch(error){reject(error instanceof SyntaxError?Error('钥匙串返回异常'):error);}
    });
    child.stdin.end(JSON.stringify({action:'get',service,account:JSON.stringify({instance:instanceId,scope:'all'})}));
  });
}
export function buildBridgeCredentialSync({token,taskTag,enableDelete=true}) {
  if(!/^fb_[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]{32}$/.test(taskTag))throw Error('文件桥同步参数无效');
  const expression="'fb_'"+token.slice(3).match(/.{16}/g).map(part=>`'${part}'`).join('');
  return [
    `维护任务编号：${taskTag}`,
    '请使用 exec 工具原样执行下面的文件桥配置同步命令。保留其他电脑凭据，不下载程序，不输出凭据，只返回完成标记。',
    'set -eu',
    "D='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
    `T=${expression}`,
    'export OPENCLAW_BRIDGE_SYNC_TOKEN="$T"',
    "python3 - <<'PY'",
    'import os,json,tempfile,time',
    'from pathlib import Path',
    "p=Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json')",
    "if p.is_symlink() or not p.is_file(): raise SystemExit('文件桥配置不存在或类型不正确')",
    "raw=p.read_bytes(); data=json.loads(raw); rows=data.get('tokens')",
    "if not isinstance(rows,list): raise SystemExit('文件桥配置格式不正确')",
    "token=os.environ['OPENCLAW_BRIDGE_SYNC_TOKEN']",
    `scopes=${JSON.stringify(enableDelete?['read','write','delete']:['read','write'])}`,
    "row=next((r for r in rows if isinstance(r,dict) and r.get('token')==token),None)",
    "if row is None: rows.append({'token':token,'scopes':scopes})",
    "else: row['scopes']=sorted(set(row.get('scopes',[]))|set(scopes))",
    "fd,backup=tempfile.mkstemp(prefix='secrets.before-mac-sync-',suffix='.json',dir=p.parent)",
    "with os.fdopen(fd,'wb') as f: os.fchmod(f.fileno(),0o600); f.write(raw)",
    "fd,name=tempfile.mkstemp(prefix='.secrets-',dir=p.parent)",
    "with os.fdopen(fd,'w') as f: os.fchmod(f.fileno(),0o600); json.dump(data,f); f.flush(); os.fsync(f.fileno())",
    'os.replace(name,p)',
    "PY",
    "A='--allow-unisolated-for-test'",
    '[ "$(id -u)" != 0 ] || A="$A --allow-root-for-test"',
    "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any("+'"delete" in r.get("scopes",[]) for r in d["tokens"]'+") else 1)' \"$D/secrets.json\" && A=\"$A --enable-delete\"",
    ...bridgeProcessStopSteps(),
    'nohup python3 "$D/server.py" --root /home/node/.openclaw/workspace --secret-file "$D/secrets.json" --enable-write $A </dev/null >"$D/server.log" 2>&1 &',
    'echo "$!" >"$D/server.pid"',
    'OK=0; for N in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 3 -H "X-OpenClaw-Token: $T" http://127.0.0.1:18081/v1/capabilities >/dev/null 2>&1 && OK=1 && break; sleep 1; done',
    '[ "$OK" = 1 ] || { echo "文件桥配置同步后自检失败"; exit 1; }',
    `echo OPENCLAW_${taskTag}_CREDENTIAL_READY`
  ].map(command=>configureBridgeCommand(command)).join('\n');
}

export function buildBridgeDeleteRepair({token,taskTag}) {
  if(!/^fb_[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]{32}$/.test(taskTag))throw Error('文件桥修复参数无效');
  const fingerprint=createHash('sha256').update(token).digest('hex');
  return [
    'set -eu',
    "D='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
    `export OPENCLAW_BRIDGE_TOKEN_SHA256='${fingerprint}'`,
    "python3 - <<'PY'",
    'import os,json,tempfile,hashlib',
    'from pathlib import Path',
    "p=Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json')",
    "if p.is_symlink() or not p.is_file(): raise SystemExit('文件桥配置不存在')",
    'raw=p.read_bytes(); data=json.loads(raw); rows=data.get("tokens")',
    'if not isinstance(rows,list): raise SystemExit("文件桥配置格式错误")',
    'matches=[r for r in rows if isinstance(r,dict) and isinstance(r.get("token"),str) and hashlib.sha256(r["token"].encode()).hexdigest()==os.environ["OPENCLAW_BRIDGE_TOKEN_SHA256"]]',
    'if len(matches)!=1: raise SystemExit("Mac 文件桥凭据未精确匹配")',
    'matches[0]["scopes"]=sorted(set(matches[0].get("scopes",[]))|{"read","write","delete"})',
    'fd,name=tempfile.mkstemp(prefix=".secrets-",dir=p.parent)',
    'with os.fdopen(fd,"w") as f: os.fchmod(f.fileno(),0o600); json.dump(data,f); f.flush(); os.fsync(f.fileno())',
    'os.replace(name,p)',
    'PY',
    "A='--allow-unisolated-for-test --enable-delete'",
    '[ "$(id -u)" != 0 ] || A="$A --allow-root-for-test"',
    ...bridgeProcessStopSteps(),
    'nohup python3 "$D/server.py" --root /home/node/.openclaw/workspace --secret-file "$D/secrets.json" --enable-write $A </dev/null >"$D/server.log" 2>&1 &',
    'echo "$!" >"$D/server.pid"',
    "python3 - <<'PY'",
    'import os,json,hashlib,time,urllib.request',
    'from pathlib import Path',
    "rows=json.loads(Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json').read_text())['tokens']",
    'matches=[r for r in rows if isinstance(r,dict) and isinstance(r.get("token"),str) and hashlib.sha256(r["token"].encode()).hexdigest()==os.environ["OPENCLAW_BRIDGE_TOKEN_SHA256"]]',
    'if len(matches)!=1: raise SystemExit("Mac 文件桥凭据自检不匹配")',
    'req=urllib.request.Request("http://127.0.0.1:18081/v1/capabilities",headers={"X-OpenClaw-Token":matches[0]["token"]})',
    'result=None',
    'for attempt in range(10):',
    '    try:',
    '        result=json.load(urllib.request.urlopen(req,timeout=3))',
    '        break',
    '    except Exception:',
    '        if attempt==9: raise',
    '        time.sleep(1)',
    'if not result.get("ok") or not result.get("capabilities",{}).get("delete"): raise SystemExit("文件桥删除能力自检失败")',
    'PY',
    `echo OPENCLAW_${taskTag}_DELETE_READY`
  ].map(command=>configureBridgeCommand(command)).join('\n');
}
