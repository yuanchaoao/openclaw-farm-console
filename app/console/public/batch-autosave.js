import {instanceFromUrl} from './batch-connection-core.js';
export class BatchAutosave {
 constructor({api,changed=()=>{}}){this.api=api;this.changed=changed;this.pending=new Map();this.last=new Map();}
 save(row){
  if(row.removed)return Promise.resolve();
  let parsed;try{parsed=instanceFromUrl(row.url);}catch{return Promise.resolve();}
  if(!row.token || row.token.length<20 || row.token.length>512)return Promise.resolve();
  const signature=JSON.stringify([parsed.url,row.token,row.name||'']);
  if(this.pending.has(row.id))return this.pending.get(row.id).then(()=>this.save(row));
  if(this.last.get(row.id)===signature)return Promise.resolve();
  row.credentialSave='saving';this.changed();
  const promise=this.api('/api/connections/register',{url:parsed.url,token:row.token,name:row.name,replace:true,deferHealth:true}).then(result=>{
   this.last.set(row.id,signature);row.registered=true;row.instanceId=result.instanceId;row.credentialSave='saved';row.credentialSaved=true;
  }).catch(()=>{row.credentialSave='error';throw Error('凭据自动保存失败，请重试；当前输入仍保留。');}).finally(()=>{this.pending.delete(row.id);this.changed();});
  this.pending.set(row.id,promise);return promise;
 }
}
