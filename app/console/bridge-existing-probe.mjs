import {configureBridgeCommand} from './remote-settings.mjs';
import {createHash} from 'node:crypto';
import {maintenanceResults} from './maintenance-results.mjs';

// A read-only probe can be replaced after it stops making progress. Keep the
// attempt identity on disk so a restart does not wait on an ancient run forever.
export function shouldRenewExistingBridgeProbe(job,now=Date.now(),maxAgeMs=120000) {
  if(job?.routeProbeVersion!==6 || !job.routeProbeSession || !/^[0-9a-f]{32}$/.test(job.routeProbeTag || ''))return true;
  const started=Number(job.routeProbeStartedAt);
  return !Number.isFinite(started) || started<=0 || started>now || now-started>=maxAgeMs;
}

// Credentials never appear in this command or its output. The remote process
// checks its own saved credentials and returns only fingerprints and a public key.
export function existingBridgeProbeCommand(tag) {
  if(!/^[0-9a-f]{32}$/.test(tag))throw Error('无效核验编号');
  const program=['import json,urllib.request,hashlib,subprocess','from pathlib import Path',
    "rows=json.loads(Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json').read_text())['tokens']",
    "stored=[hashlib.sha256(r['token'].encode()).hexdigest() for r in rows if isinstance(r,dict) and isinstance(r.get('token'),str)]",
    "healthy=False",
    "exec(\"try:\\n r=next((r for r in rows if isinstance(r,dict) and isinstance(r.get('token'),str)),None)\\n healthy=bool(r and json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18081/v1/capabilities',headers={'X-OpenClaw-Token':r['token']}),timeout=5)).get('ok') is True)\\nexcept Exception:\\n healthy=False\")",
    "kp=Path('/home/node/.ssh/openclaw_tunnel')",
    "key=''",
    "exec(\"try:\\n p=subprocess.run(['ssh-keygen','-y','-P','','-f',str(kp)],capture_output=True,text=True,timeout=5) if kp.is_file() else None\\n key=p.stdout.strip() if p and p.returncode==0 else ''\\nexcept Exception:\\n key=''\")",
    `print('BRIDGE_PROBE_${tag} '+json.dumps({'stored':stored,'healthy':healthy,'publicKey':key}))`].join('; ');
  return configureBridgeCommand(["python3 - <<'PY'",program,'PY'].join('\n'));
}
export function parseExistingBridgeProbe(history,{tag,token,commandDigest,requestDigest}) {
  const result=typeof history?.executionText==='string'?history:maintenanceResults(history,{expectedPromptHash:commandDigest,expectedRequestDigest:requestDigest});
  if(!result.requestFound || result.failure || result.approval || !result.turnSettled)return null;
  const match=result.executionText.match(new RegExp(`(?:^|\\n)BRIDGE_PROBE_${tag} (\\{[^\\n]+\\})`));
  if(!match)return null;
  let data;try{data=JSON.parse(match[1]);}catch{return null;}
  if(data.publicKey && !/^ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?$/.test(data.publicKey))return null;
  return {publicKey:data.publicKey,serviceHealthy:data.healthy===true,credentialMatches:Array.isArray(data.stored)&&data.stored.includes(createHash('sha256').update(token).digest('hex'))};
}

// A settled exec result may omit the redundant PUBKEY_END echo while still
// returning the tagged public key and SERVICE_READY. Accept that exact pair
// from execution output so a healthy bridge does not wait for a missing echo.
export function parseBridgeRestartPublicKey(executionText,tag) {
  if(!/^[0-9a-f]{32}$/.test(tag) || typeof executionText!=='string')return '';
  const escaped=`OPENCLAW_${tag}_`;
  const match=executionText.match(new RegExp(`(?:^|\\n)${escaped}PUBKEY_BEGIN\\s+(ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?)\\s+(?:${escaped}PUBKEY_END\\s+)?${escaped}SERVICE_READY(?=\\s|$)`));
  return match?.[1] || '';
}
