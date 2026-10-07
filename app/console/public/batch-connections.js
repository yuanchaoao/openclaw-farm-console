import {isDevicePairing} from './pairing-lifecycle.js';
import {remoteApprovalHelp} from './remote-approval-help.js';
import {BatchAutosave} from './batch-autosave.js';
import {approvalPrompt,allApprovalPrompts} from './batch-approval-prompt.js';
import {BatchConnections,savedRows,bridgeActionLabel,isBatchEligibleName} from './batch-connection-core.js';
import {PERFORMANCE_PREFERENCE_KEY,performanceSettings,batchCounts} from './batch-performance.js';
import {reconcileInstanceRows,removeInstanceRow,announceInstanceListChange,INSTANCE_LIST_EVENT,INSTANCE_LIST_STORAGE_KEY} from './instance-list-sync.js';
const el=id=>document.getElementById(id), key='openclawFarm.batch.v1', views=new Map();
const labels={unknown:'未检查',online:'已连接',failed:'失败',checking:'检查中',installing:'安装中',approval:'待批准',unconfigured:'未配置',blocked:'受阻',awaiting_approval:'待批准',queued:'排队中'};
const busy=new Set(['queued','registering','checking','installing']);
async function api(url,body) {
  const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok || data.ok===false) {const error=Error(data.error || data.message || '操作失败');error.status=response.status;throw error;}
  return data;
}
function notice(message) {el('batchNotice').textContent=message;}
let renderTimer=null;
function scheduleRender(){if(renderTimer===null)renderTimer=setTimeout(()=>{renderTimer=null;render();},80);}
const batch=new BatchConnections({api,changed:scheduleRender});
const autosave=new BatchAutosave({api,changed:scheduleRender});
const saveTimers=new Map();
function scheduleSave(row){if(row.removed)return;clearTimeout(saveTimers.get(row.id));saveTimers.set(row.id,setTimeout(()=>{saveTimers.delete(row.id);autosave.save(row).catch(e=>notice(e.message));},400));}
async function removeRow(row) {
 try {
  clearTimeout(saveTimers.get(row.id));saveTimers.delete(row.id);
  await removeInstanceRow({row,autosave,api});
  batch.rows=batch.rows.filter(item=>item!==row);
  batch.pending=batch.pending.filter(task=>task.row!==row);
  batch.busyInstances.delete(row.instanceId);
  render();announceInstanceListChange();
  notice('已移出当前管理列表，停止后续检查和安装；历史记录已保留。');
 } catch(error){notice('移出失败：'+error.message);render();}
}
let membershipRequest=null;
async function syncMembership() {
 if(membershipRequest)return membershipRequest;
 membershipRequest=(async()=>{
  const data=await api('/api/instances');
  batch.rows=reconcileInstanceRows(batch.rows,data);
  batch.pending=batch.pending.filter(task=>!task.row.removed);
  render();return data;
 })().finally(()=>{membershipRequest=null;});
 return membershipRequest;
}
let performanceConfig={},performancePreference=null;
try{performancePreference=JSON.parse(localStorage.getItem(PERFORMANCE_PREFERENCE_KEY)||'null');}catch{}
function applyPerformance(){
 const settings=performanceSettings(performanceConfig,performancePreference),select=el('batchLimit');
 select.replaceChildren(...settings.choices.map(value=>{const option=document.createElement('option');option.value=String(value);option.textContent=String(value);return option;}));
 select.value=String(settings.limit);batch.limit=settings.limit;
 el('batchSpeed').textContent=`速度优先 · 同时配置 ${settings.limit} 个实例`;
 el('batchCapacity').textContent=`最多 ${settings.maximum} 个实例同时推进，逐行显示实时结果；待批准或失败的实例单独处理。`;
 batch.pump();
}
applyPerformance();
const performanceReady=api('/api/performance').then(value=>{performanceConfig=value;applyPerformance();}).catch(()=>{});
function options(){return {allowSharedWorkspace:el('batchShared').checked,enableDelete:el('batchDelete').checked,replace:el('batchReplace').checked};}
async function start(rows,mode){try{const eligible=rows.filter(row=>isBatchEligibleName(row.name));const protectedCount=rows.length-eligible.length;if(!eligible.length)throw Error(protectedCount?'所选实例都是受保护的命名实例；批量操作只允许数字名称实例':'请先选择实例');if(mode==='check' && eligible.every(row=>row.registered)){await Promise.all(eligible.map(row=>batch.refreshConnection(row)));if(protectedCount)notice(`已跳过 ${protectedCount} 个受保护的命名实例`);return;}await performanceReady;await Promise.all(eligible.map(row=>autosave.save(row)));batch.start(eligible,mode,{...options(),replace:false});notice(protectedCount?`已跳过 ${protectedCount} 个受保护的命名实例`:'');}catch(e){notice(e.message);}}
function button(text,fn){const b=document.createElement('button');b.className='ghost';b.textContent=text;b.addEventListener('click',fn);return b;}
async function copyPrompt(text){
 if(!text){notice('当前没有需要手动处理的批准提示词。');return;}
 try{await navigator.clipboard.writeText(text);notice('提示词已复制，已包含对应实例链接。');}
 catch{const box=el('batchCopyFallback');box.hidden=false;box.value=text;box.focus();box.select();notice('浏览器未允许自动复制，提示词已选中，请按 ⌘C。');}
}
function createRow(row){
 const tr=document.createElement('tr');
 // Static markup only; all supplied values are assigned as text or input values.
 tr.innerHTML='<td><input type="checkbox" aria-label="选择实例"></td><td><input data-field="name" maxlength="40" placeholder="备注名"><input data-field="url" placeholder="实例链接"><input data-field="token" type="password" autocomplete="off" placeholder="Gateway Token"><small data-save-status role="status"></small></td><td data-light="mcp"></td><td data-light="bridge"></td><td><pre></pre><details><summary>配对 / 批准信息</summary><pre></pre></details><div class="batch-actions"></div></td>';
 const select=tr.querySelector('input[type=checkbox]');select.checked=row.selected;select.onchange=()=>{row.selected=select.checked;render();};
 for(const input of tr.querySelectorAll('[data-field]')){input.value=row[input.dataset.field] || '';input.setAttribute('aria-label',input.placeholder);input.addEventListener('input',()=>{row[input.dataset.field]=input.value;if(input.dataset.field==='name'){row.batchEligible=isBatchEligibleName(input.value);row.protectedName=!row.batchEligible;if(!row.batchEligible)row.selected=false;}scheduleSave(row);render();});}
 const actions=tr.querySelector('.batch-actions');const check=button('检查',()=>start([row],'check'));check.dataset.checkConnection='true';const install=button('一键安装文件桥',()=>start([row],'bridge'));install.dataset.installBridge='true';const remove=button('移出列表',()=>removeRow(row));remove.title='同步移出后台管理范围，停止后续检查和安装，保留历史记录';actions.append(check,install,remove);
 const repair=button('远端审批修复说明',()=>{try{copyPrompt(remoteApprovalHelp(row.instanceId));}catch(e){notice(e.message);}});repair.dataset.remoteHelp='true';actions.append(repair);
 const copy=button('复制提示词',async()=>{if(isDevicePairing(row.approval))await batch.refreshConnection(row);await copyPrompt(approvalPrompt(row));});copy.dataset.copyApproval='true';actions.prepend(copy);
 el('batchRows').append(tr);views.set(row.id,tr);return tr;
}
function render(){
 const present=new Set(batch.rows.map(row=>row.id));
 for(const [id,tr] of views)if(!present.has(id)){tr.remove();views.delete(id);}
 for(const row of batch.rows){
  const tr=views.get(row.id)||createRow(row),locked=busy.has(row.state),eligible=isBatchEligibleName(row.name);
  row.batchEligible=eligible;row.protectedName=!eligible;if(!eligible)row.selected=false;
  const selector=tr.querySelector('input[type=checkbox]');selector.checked=row.selected;selector.disabled=!eligible || locked;selector.title=eligible?'':'受保护的命名实例不能参加批量调用';
  for(const input of tr.querySelectorAll('[data-field]'))input.disabled=locked;
  for(const b of tr.querySelectorAll('button'))b.disabled=locked;
  const check=tr.querySelector('[data-check-connection]');check.disabled=!eligible || !!row.healthChecking;check.textContent=row.healthChecking?'检查中…':'检查';
  const repair=tr.querySelector('[data-remote-help]');repair.hidden=!(row.state==='blocked' && row.blockerCode==='REMOTE_INTERNAL_IDENTITY_UNVERIFIED');repair.disabled=false;
  tr.dataset.state=row.state;
  const install=tr.querySelector('[data-install-bridge]');install.textContent=bridgeActionLabel(row);install.disabled=!eligible || locked;
  tr.querySelector('[data-save-status]').textContent=!eligible?'受保护的命名实例 · 批量操作已禁用':row.credentialSave==='saving'?'正在保存到钥匙串…':row.credentialSave==='error'?'保存失败，请重试':row.registered?'已保存到钥匙串 · 刷新后继续使用':'填好链接和完整 Token 后自动保存';
  tr.querySelector('[data-field=token]').placeholder=row.registered?'已保存 · 无需重填（输入新 Token 可替换）':'Gateway Token';
  for(const kind of ['mcp','bridge']){const cell=tr.querySelector(`[data-light=${kind}]`),fresh=row.liveStatus && Date.now()-row.liveStatus.checkedAt<60000,value=row.liveStatus?row.liveStatus[kind]:row[kind],stale=!fresh && (row.stale || !!row.liveStatus);cell.textContent=(labels[value] || value)+(stale?'（上次结果）':'');cell.dataset.status=stale?'stale':value;}

  tr.querySelector('pre').textContent=[row.healthMessage,(['blocked','awaiting_approval'].includes(row.state) && row.blockedAt)?`等待 ${Math.max(0,Math.floor((Date.now()-new Date(row.blockedAt).getTime())/60000))} 分钟`:'',row.message || (row.registered?'凭据已保存，等待检查':'等待开始')].filter(Boolean).flatMap(text=>String(text).split('\n')).filter((line,index,lines)=>lines.indexOf(line)===index).join('\n');
  const prompt=approvalPrompt(row),copy=tr.querySelector('[data-copy-approval]');copy.hidden=!prompt && !isDevicePairing(row.approval);copy.disabled=!!row.healthChecking;copy.textContent=isDevicePairing(row.approval)?'核验并复制配对说明':'复制提示词';
  const details=tr.querySelector('details');details.hidden=!row.approval;
  details.querySelector('pre').textContent=prompt || (isDevicePairing(row.approval)?'配对编号尚未核验或已过期，请点击核验并复制。':row.approval ? '正在通过 MCP 自动处理本次执行批准，无需手动复制命令。' : '');
 }
 el('batchCopyAll').disabled=!allApprovalPrompts(batch.rows) && !batch.rows.some(row=>isDevicePairing(row.approval));
 const counts=batchCounts(batch.rows);
 for(const kind of ['running','queued','pending','complete'])el(`batchCount-${kind}`).textContent=String(counts[kind]);
 el('batchSummary').textContent=`共 ${counts.total} 个实例 · 运行 ${counts.running} · 排队 ${counts.queued} · 待处理 ${counts.pending} · 完成 ${counts.complete}`;
 try{localStorage.setItem(key,JSON.stringify(savedRows(batch.rows)));}catch{}
}
function add(data){if(batch.rows.length>=100)throw Error('每批最多 100 个实例');const row=batch.add(data);autosave.save(row).catch(e=>notice(e.message));}
el('batchCopyAll').onclick=async()=>{await Promise.all(batch.rows.filter(row=>isDevicePairing(row.approval)).map(row=>batch.refreshConnection(row)));await copyPrompt(allApprovalPrompts(batch.rows));};
el('batchAdd').onclick=()=>{try{add();}catch(e){notice(e.message);}};
el('batchAll').onchange=()=>{for(const row of batch.rows)row.selected=el('batchAll').checked && isBatchEligibleName(row.name);render();};
el('batchCheck').onclick=()=>start(batch.rows.filter(r=>r.selected),'check');
el('batchStart').onclick=()=>start(batch.rows.filter(r=>r.selected),'bridge');
el('batchImport').onclick=()=>{try{for(const line of el('batchPaste').value.split('\n').filter(s=>s.trim())){const [url,token,name]=line.split(/\t|\|/).map(s=>s.trim());if(!batch.rows.some(r=>r.url===url))add({url,token,name});}notice('已加入列表，Token 保留在输入框中。');}catch(e){notice(e.message);}};
el('batchLoad').onclick=async()=>{try{const data=await syncMembership();let protectedCount=0;for(const item of data.instances || []){const eligible=item.batchEligible===true;if(!eligible)protectedCount++;if(!batch.rows.some(r=>r.instanceId===item.id))add({instanceId:item.id,url:item.webUrl,name:item.name,registered:item.hasCredential,bridgeConfigured:!!item.fileBridge,batchEligible:eligible,protectedName:!eligible,selected:eligible});}notice(`已同步当前登记实例；数字名称实例可批量调用${protectedCount?`，${protectedCount} 个命名实例已保护`:''}。`);}catch(e){notice(e.message);}};
el('batchLimit').addEventListener('change',()=>{performancePreference={version:2,manual:true,limit:Number(el('batchLimit').value)};try{localStorage.setItem(PERFORMANCE_PREFERENCE_KEY,JSON.stringify(performancePreference));}catch{}applyPerformance();});
window.addEventListener('pagehide',()=>{try{localStorage.setItem(key,JSON.stringify(savedRows(batch.rows)));}catch{}});
let restored=[];try{restored=JSON.parse(localStorage.getItem(key)||'[]');}catch{}
for(const saved of Array.isArray(restored)?restored.slice(0,100):[]){const eligible=isBatchEligibleName(saved.name);batch.add({id:saved.id,instanceId:saved.instanceId,name:saved.name,url:saved.url,registered:saved.registered,selected:eligible && saved.selected,token:'',approval:null,jobId:'',batchEligible:eligible,protectedName:!eligible,stale:true,state:'idle',message:eligible?'正在核对后台任务与实时连接':'受保护的命名实例不能参加批量调用'});}
if(!batch.rows.length)add();
// Recovery reads backend state by instance; it never resumes or sends an installation.

window.addEventListener('beforeunload',event=>{if(autosave.pending.size || saveTimers.size){event.preventDefault();event.returnValue='';}});

async function refreshBatchConnections(){
 await syncMembership();
 const rows=batch.rows.filter(row=>row.registered && isBatchEligibleName(row.name) && (!document.hidden || isDevicePairing(row.approval)));let next=0;
 await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{while(next<rows.length){const row=rows[next++],pendingPairing=row.pairingPending || isDevicePairing(row.approval);row.pairingPending=!!pendingPairing;await batch.syncLatest(row).catch(()=>{});if(!pendingPairing && !isDevicePairing(row.approval))await batch.refreshConnection(row);}}));
}
refreshBatchConnections().catch(()=>{});
setInterval(()=>refreshBatchConnections().catch(()=>{}),30000);

window.addEventListener('pageshow',()=>refreshBatchConnections().catch(()=>{}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshBatchConnections().catch(()=>{});});
window.addEventListener(INSTANCE_LIST_EVENT,()=>syncMembership().catch(()=>{}));
window.addEventListener('storage',event=>{if(event.key===INSTANCE_LIST_STORAGE_KEY)syncMembership().catch(()=>{});});
