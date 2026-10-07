import {randomUUID,createHash} from 'node:crypto';
export async function validateBridgeOperations(call,instanceId,enableDelete=true) {
  if(!enableDelete)throw Object.assign(Error('完整验收需要删除本次唯一测试文件的权限；文件桥健康与写入权限可另行检查'),{code:'VALIDATION_DELETE_REQUIRED'});
  try {
    await call(['file-list',instanceId,'.'],'',[0],45000);
  } catch (error) {
    // A shared root can exceed the listing limit, or contain one unreadable
    // entry. Verify the root itself, then prove file operations independently.
    // A root listing is not authoritative in a busy shared workspace. A
    // successful root stat plus the unique file round trip below proves the
    // bridge operations without letting one bad sibling block recovery.
    const root=await call(['file-stat',instanceId,'.'],'',[0],45000);
    if ((root.stat || root).type!=='dir') throw Error('文件桥根目录不是文件夹');
  }
  const path=`.openclaw-bridge-validation-${randomUUID()}.txt`;
  const content=JSON.stringify({purpose:'bridge-validation',nonce:randomUUID()});
  const hash=createHash('sha256').update(content).digest('hex');
  // A JSON body lets the existing CLI JSON transport compare the actual read-back.
  let written=false;
  try {
    await call(['file-write',instanceId,path,'--content-stdin','--approved-write'],content,[0],45000);written=true;
    const read=await call(['file-read',instanceId,path],'',[0],45000);
    if(JSON.stringify(read)!==content)throw Error('测试文件读回内容不一致');
    const stat=await call(['file-stat',instanceId,path],'',[0],45000);
    if((stat.stat || stat).sha256!==hash)throw Error('测试文件哈希不一致');
  } finally {
    if(written)await call(['file-delete',instanceId,path,'--expected-sha256',hash,'--approved-delete'],'',[0],45000);
  }
  return {read:true,write:true,delete:true,checkedAt:Date.now()};
}
