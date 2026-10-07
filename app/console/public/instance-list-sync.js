import {instanceFromUrl} from './batch-connection-core.js';
export const INSTANCE_LIST_EVENT='openclaw:instances-changed';
export const INSTANCE_LIST_STORAGE_KEY='openclawFarm.instanceListRevision';
export function announceInstanceListChange() {
  window.dispatchEvent(new Event(INSTANCE_LIST_EVENT));
  try {localStorage.setItem(INSTANCE_LIST_STORAGE_KEY,crypto.randomUUID());} catch {}
}
export function reconcileInstanceRows(rows,{instances=[],archivedInstanceIds=[]}) {
  const removed=new Set(archivedInstanceIds),active=new Map(instances.map(item=>[item.id,item]));
  return rows.filter(row=>{
    let id=row.instanceId;
    try {id=instanceFromUrl(row.url).id;} catch {}
    if(removed.has(id)){row.removed=true;return false;}
    const item=active.get(id);
    if(item){row.instanceId=id;row.name=item.name;row.registered=item.hasCredential;row.bridgeConfigured=Boolean(item.fileBridge);row.batchEligible=item.batchEligible===true;row.protectedName=item.protectedName===true;row.selected=row.batchEligible ? row.selected : false;}
    return !row.removed;
  });
}
export async function removeInstanceRow({row,autosave,api}) {
  row.removed=true;
  // Finish an already-issued autosave, then archive. Further saves are disabled.
  // No secret is copied to the archive request or browser storage.
  await autosave.pending.get(row.id)?.catch(()=>{});
  let id=row.instanceId;
  try {id=instanceFromUrl(row.url).id;} catch {}
  try {
    if(id)await api(`/api/instances/${encodeURIComponent(id)}/archive`,{});
  } catch(error) {
    if(error.code!=='INSTANCE_NOT_FOUND' && !/实例不存在或尚未注册/.test(error.message)) {
      row.removed=false;throw error;
    }
  }
  return id;
}
