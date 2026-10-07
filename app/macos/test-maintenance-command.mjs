import test from 'node:test';import assert from 'node:assert/strict';
import {sealMaintenancePrompt} from '../console/maintenance-command.mjs';
test('sealed command preserves exact bytes including URL percent escapes, quotes and newlines',()=>{const script=`set -eu\ncurl 'https://example.com/%E4%B8%8D'\nT='ab'\npython3 - <<'PY'\nprint("汉字")\nPY`;const out=sealMaintenancePrompt('任务编号\n'+script);const b=out.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1];assert.equal(Buffer.from(b,'base64').toString('utf8'),script);assert.equal(out.slice(out.indexOf('set -eu\n')).split('\n').length,2);});
test('unmarked script cannot be sealed',()=>assert.throws(()=>sealMaintenancePrompt('echo hello')));

import {stageMaintenanceCommands} from '../console/maintenance-command.mjs';
import {gunzipSync} from 'node:zlib';
test('small chunks reconstruct exact original script and final execution requires pinned checksum',()=>{const script='set -eu\n'+Array.from({length:100},(_,i)=>`echo "value ${i} 演示"`).join('\n');const staged=stageMaintenanceCommands('维护任务编号：'+'a'.repeat(32)+'\n'+script,'a'.repeat(32));const bytes=Buffer.concat(staged.commands.slice(0,-1).map(c=>Buffer.from(c.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1],'base64')));assert.equal(gunzipSync(bytes).toString(),script);assert.ok(staged.commands.every(c=>c.length<700));assert.match(staged.commands.at(-1),/assert hashlib.sha256/);});
