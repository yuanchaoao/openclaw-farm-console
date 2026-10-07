import {createHash, createPublicKey} from 'node:crypto';

const STATUS='/proc/self/status', PASSWD='/etc/passwd', IDENTITY='/home/node/.openclaw/identity/device.json';
const paths=new Set([STATUS,PASSWD,IDENTITY]);
function body(message) {
  if(typeof message?.content==='string')return message.content;
  if(Array.isArray(message?.content))return message.content.filter(p=>p.type==='text' && typeof p.text==='string').map(p=>p.text).join('\n');
  if(typeof message?.details?.content==='string')return message.details.content;
  if(typeof message?.details?.text==='string')return message.details.text;
  return '';
}
function argsOf(value) {try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}}

// Only matched read tool results are evidence. Do not return the identity document,
// which can also contain a private key.
export function extractPermissionIdentity(history,{instanceId,sessionKey,checkedAt=Date.now(),expectedRequest}={}) {
  const fail=missing=>({ok:false,code:'REMOTE_INTERNAL_IDENTITY_UNVERIFIED',missingEvidence:[missing],checkedAt});
  const expected=`agent:main:openclaw-control-ui:`;
  if(typeof instanceId!=='string' || !instanceId.startsWith('ins_') || typeof sessionKey!=='string' || !sessionKey.startsWith(expected))return fail('绑定实例的主 agent 独立维护会话');
  const envelope=history?.result || history;
  const returnedSession=history?.sessionKey ?? envelope?.sessionKey;
  const returnedInstance=history?.instanceId ?? envelope?.instanceId;
  if(returnedSession!==sessionKey || (returnedInstance!==undefined && returnedInstance!==instanceId))return fail('当前实例和维护会话的匹配查询结果');
  const messages=envelope?.messages;
  if(!Array.isArray(messages) || !Number.isFinite(checkedAt))return fail('当前维护回合的读取记录');
  const lastUser=messages.findLastIndex(m=>m.role==='user' && !/An async command|Exec (?:completed|finished|denied)/i.test(body(m)));
  if(lastUser<0)return fail('当前维护回合的用户请求');
  if(expectedRequest && !body(messages[lastUser]).includes(expectedRequest))return fail('本次只读核验请求的匹配记录');
  const calls=new Map(),used=new Set(),files=new Map();
  for(const message of messages.slice(lastUser+1)) {
    if(message.role==='assistant') {
      for(const part of Array.isArray(message.content)?message.content:[]) {
        if(part.type!=='toolCall' || !['read','exec'].includes(part.name) || typeof part.id!=='string')continue;
        const args=argsOf(part.arguments);
        const path=part.name==='read'?(args?.path ?? args?.file_path ?? args?.file)
          :typeof args?.command==='string'?[...paths].find(path=>[`cat ${path}`,`cat -- ${path}`,`cat '${path}'`,`cat "${path}"`].includes(args.command.trim())):null;
        if(paths.has(path)) {
          if(calls.has(part.id))return fail('唯一的只读工具调用编号');
          calls.set(part.id,{path,tool:part.name});
        }
      }
    } else if(message.role==='toolResult' || message.role==='tool') {
      const id=message.toolCallId ?? message.tool_call_id;
      if(!calls.has(id))continue;
      if(used.has(id) || (message.toolName && message.toolName!==calls.get(id).tool) || message.isError || message.details?.status==='error' || message.details?.error)return fail('成功且唯一的只读工具结果');
      used.add(id);
      const path=calls.get(id).path,text=body(message);
      if(!text)return fail(`完整读取 ${path}`);
      if(files.has(path) && files.get(path)!==text)return fail(`一致的远端身份读取结果：${path}`);
      files.set(path,text);
    }
  }
  for(const path of paths)if(!files.has(path))return fail(`远端实际读取 ${path}`);
  const uid=files.get(STATUS).match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
  if(!uid || new Set(uid.slice(1)).size!==1)return fail('一致的远端进程实际与有效 UID');
  const users=files.get(PASSWD).split('\n').filter(Boolean).map(line=>line.split(':')).filter(p=>p.length===7 && p[2]===uid[1]);
  if(users.length!==1 || users[0][0]!=='node' || users[0][5]!=='/home/node')return fail('运行 UID 对应 node 用户及 /home/node 主目录');
  let identity,key,jwk;
  try {
    identity=JSON.parse(files.get(IDENTITY));
    if(identity.version!==1 || typeof identity.publicKeyPem!=='string' || !identity.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----'))return fail('有效的设备公钥文件');
    key=createPublicKey(identity.publicKeyPem);jwk=key.export({format:'jwk'});
  } catch {return fail('可解析的设备身份与公钥');}
  if(key.asymmetricKeyType!=='ed25519' || jwk.kty!=='OKP' || jwk.crv!=='Ed25519' || typeof jwk.x!=='string')return fail('Ed25519 设备公钥');
  const raw=Buffer.from(jwk.x,'base64url');
  const deviceId=createHash('sha256').update(raw).digest('hex');
  if(raw.length!==32 || deviceId!==identity.deviceId)return fail('设备 ID 与公钥 SHA256 指纹一致');
  return {ok:true,instanceId,sessionKey,deviceId,publicKey:raw.toString('base64url'),runningUser:'node',stateDir:'/home/node/.openclaw',source:'authenticated_remote_read',checkedAt};
}
