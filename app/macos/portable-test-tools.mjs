import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {join} from 'node:path';

export const pythonBin=process.env.OPENCLAW_PYTHON_BIN || process.env.OPENCLAW_PYTHON || (process.platform==='win32'?'python':'python3');

// Git Bash executes the Linux maintenance command fixtures on Windows. Prefer
// it to the optional WSL bash shim, which need not have a Linux distribution.
const candidates=[process.env.OPENCLAW_TEST_BASH,...(process.platform==='win32'
  ? [join(process.env.ProgramFiles || 'C:\\Program Files','Git','bin','bash.exe'),join(process.env.LOCALAPPDATA || '', 'Programs','Git','bin','bash.exe')]
  : []),'bash'].filter(Boolean);
export const bashBin=candidates.find(candidate=>{
  const result=spawnSync(candidate,['-c','printf openclaw-shell-fixture'],{encoding:'utf8',timeout:5000});
  return result.status===0 && result.stdout==='openclaw-shell-fixture';
});
export const bashSyntaxSkip=!bashBin && process.platform==='win32'?'Git Bash is unavailable; only Linux shell syntax checks are skipped':false;

export function assertShellSyntax(script) {
  assert.ok(bashBin,'Bash must be available to check Linux maintenance syntax');
  const result=spawnSync(bashBin,['-n'],{input:script,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr || result.error?.message);
}
export const shellPath=value=>process.platform==='win32'?value.replaceAll('\\','/'):value;
export function runShell(script,args=[],options={}) {
  assert.ok(bashBin,'Install Git Bash to execute Linux installer command fixtures');
  return execFileSync(bashBin,['-s','--',...args.map(shellPath)],{...options,input:script});
}
