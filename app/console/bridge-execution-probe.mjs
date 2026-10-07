import {createHash} from 'node:crypto';
export const executionCommandFingerprint=command=>createHash('sha256').update(String(command).trim().split(/\s+/).join(' ')).digest('hex');
export function executionProbeCommand(fingerprint,tag) {
  if(!/^[0-9a-f]{64}$/.test(fingerprint)||!/^[0-9a-f]{32}$/.test(tag))throw Error('无效执行核验参数');
  const program=['import os,json,hashlib','from pathlib import Path',
    "paths=[p for p in Path('/proc').glob('[0-9]*/cmdline') if p.stat().st_uid==os.getuid()]",
    "rows=[p.read_bytes().split(bytes([0])) for p in paths]",
    `active=sum(1 for row in rows if any(hashlib.sha256(b' '.join(a.split())).hexdigest()=='${fingerprint}' for a in row))`,
    `print('EXECUTION_PROBE_${tag} '+json.dumps({'checked':len(rows),'active':active}))`].join('; ');
  return ["python3 - <<'PY'",program,'PY'].join('\n');
}
export function parseExecutionProbe(result,tag) {
  if(result.failure||result.approval||!result.requestFound||!result.turnSettled)return null;
  const m=result.executionText.match(new RegExp(`(?:^|\\n)EXECUTION_PROBE_${tag} (\\{[^\\n]+\\})`));
  let data;try{data=JSON.parse(m?.[1]);}catch{return null;}
  return Number.isInteger(data.checked)&&data.checked>0&&Number.isInteger(data.active)&&data.active>=0?{active:data.active}:null;
}
