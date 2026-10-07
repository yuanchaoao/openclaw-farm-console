export function permissionStageLabel(stage) {
  return {local_forward_repair:'正在恢复当前实例的本地隧道',route_check:'正在核对现有文件桥和隧道端口',permission_check:'正在核验审批客户端身份与权限',permission_repair:'正在通过 MCP 补齐已授权的管理权限',permission_verify:'正在验证执行审批，随后继续文件桥安装'}[stage] || '';
}
export function bridgeActionLabel(row) {
  return row.state==='blocked' && /^(REMOTE_INTERNAL_|PERMISSION_)/.test(row.blockerCode || '') ? '核验并补齐权限后继续安装' : row.bridgeConfigured || row.state==='complete' ? '检查连接 / 自动修复' : '一键安装文件桥';
}
import {isDevicePairing,verifiedPairing} from './pairing-lifecycle.js';
export function isBatchEligibleName(value) {return /^\d+$/.test(String(value || '').trim());}
export function instanceFromUrl(value) {
  const url = new URL(value);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password) throw Error('实例链接无效');
  const id = url.pathname.match(/(?:^|\/)(ins_[a-zA-Z0-9]+)(?:\/|$)/)?.[1];
  if (!id) throw Error('链接中缺少 ins_ 开头的实例编号');
  return {id, url: `${url.origin}/${id}/chat`};
}

export function savedRows(rows) {
  return rows.filter(r => {try{return r.instanceId && instanceFromUrl(r.url).id===r.instanceId;}catch{return false;}}).map(r => ({
    id:r.id, instanceId:r.instanceId, name:r.name, url:instanceFromUrl(r.url).url,
    registered:r.registered, selected:r.selected,
    // Browser storage retains list preferences only. Backend owns task and approval truth.
    jobId:r.jobId || '' 
  }));
}

export class BatchConnections {
  constructor({api,changed=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),limit=100}) {
    this.api=api; this.changed=changed; this.sleep=sleep; this.limit=Number.isInteger(limit) && limit>0 ? Math.min(limit,100) : 100;
    this.rows=[]; this.pending=[]; this.running=new Set(); this.busyInstances=new Set();
  }
  add(data={}) {
    const row={id:crypto.randomUUID(),url:'',token:'',name:'',selected:true,registered:false,
      state:'idle',mcp:'unknown',bridge:'unknown',message:'等待开始',jobId:'',...data};
    this.rows.push(row); this.changed(); return row;
  }
  update(row,patch) {
    if(row.removed)return;
    if (patch.message) {
      let message=String(patch.message);
      for (const item of this.rows) if (item.token) message=message.split(item.token).join('[已隐藏]');
      patch.message=message.replace(/(?:sk-|fb_)[\w-]{16,}/g,'[已隐藏]').slice(-1800);
    }
    Object.assign(row,patch); this.changed();
  }
  applyJob(row,job) {
    if(!job)return false;
    if(job.instanceId && job.instanceId!==row.instanceId)throw Error('后台任务实例不匹配，已停止跟踪');
    if(job.status==='archived'){row.removed=true;this.rows=this.rows.filter(item=>item!==row);this.changed();return true;}
    const status=job.status, stopped=['blocked','awaiting_approval','waiting','failed'].includes(status);
    this.update(row,{jobId:job.id || job.jobId || row.jobId,backendStatus:status,
      blockerCode:job.blockerCode || '',approvalKind:job.approvalKind || '',checkedAt:job.checkedAt,blockedAt:job.blockedAt || job.updatedAt,
      nextAction:job.nextAction || '',approval:job.approval || null,
      state:status==='running'?'installing':status==='waiting'?'interrupted':status,
      message:[permissionStageLabel(job.stage),job.message || job.error || '',typeof job.nextAction==='string'?job.nextAction:job.nextAction?.label || ''].filter(Boolean).filter((text,index,items)=>items.indexOf(text)===index).join('\n')});
    if(stopped){this.update(row,{bridge:status==='awaiting_approval'?'approval':status==='failed'?'failed':'blocked'});return true;}
    if(status==='complete'){this.finish(row,job.result || {stage:'complete',message:job.message});return true;}
    return false;
  }
  async syncLatest(row) {
    if(!row.instanceId || row.removed)return;
    const response=await this.api(`/api/connections/instances/${encodeURIComponent(row.instanceId)}/latest`);
    if(response.archived){row.removed=true;this.rows=this.rows.filter(item=>item!==row);this.changed();return;}
    const job=response.job ?? (response.status?response:null);
    if(job)this.applyJob(row,job);
    else this.update(row,{jobId:'',approval:null,backendStatus:'',state:'idle',message:'暂无安装任务，可检查或一键安装'});
    return job;
  }
  async refreshConnection(row) {
    this.healthChecks ||= new Map();
    if(this.healthChecks.has(row.id))return this.healthChecks.get(row.id);
    if(!row.registered || !row.instanceId || row.removed)return;
    const request=(async()=>{
      this.update(row,{healthChecking:true});
      const [mcp,bridge]=await Promise.allSettled([
        this.api('/api/connections/mcp/check',{instanceId:row.instanceId}),
        this.api('/api/actions',{instanceId:row.instanceId,action:'bridge_health'})
      ]);
      const mcpValue=mcp.status==='fulfilled'?(mcp.value.online?'online':mcp.value.stage==='pairing_required'?'approval':'failed'):'failed';
      const bridgeValue=bridge.status==='fulfilled' && bridge.value.result?.ok===true?'online':bridge.status==='rejected' && /尚未配置/.test(bridge.reason?.message||'')?'unconfigured':'failed';
      const pairing=mcp.status==='fulfilled' && mcp.value.stage==='pairing_required';
      const approvalPatch=pairing?{approval:verifiedPairing(mcp.value)}:
        mcpValue==='online' && isDevicePairing(row.approval)?{approval:null}:
        isDevicePairing(row.approval)?{approval:{...row.approval,checkedAt:0}}:{};
      this.update(row,{...approvalPatch,pairingPending:pairing || (mcp.status==='rejected' && row.pairingPending===true),healthChecking:false,stale:false,liveStatus:{mcp:mcpValue,bridge:bridgeValue,checkedAt:Date.now()},
        ...(bridgeValue==='online'?{bridgeConfigured:true}:{}),
        healthMessage:`MCP：${mcpValue==='online'?'已连接':mcpValue==='approval'?'待配对':'检查未通过'}；文件桥：${bridgeValue==='online'?'已连接':bridgeValue==='unconfigured'?'未配置':'检查未通过'}`});
    })().finally(()=>this.healthChecks.delete(row.id));
    this.healthChecks.set(row.id,request);return request;
  }
  start(rows,mode,options={}) {
    if (mode==='bridge' && options.allowSharedWorkspace!==true) throw Error('请先勾选允许所选实例使用共享工作区');
    const ids=new Set();
    for (const row of rows) {
      if(row.removed)continue;
      if(!isBatchEligibleName(row.name)){this.update(row,{selected:false,state:'blocked',blockerCode:'NAMED_INSTANCE_AUTHORIZATION_REQUIRED',message:'受保护的命名实例不能参加批量调用；只有主人在当前任务中明确授权后才能单独调用'});continue;}
      if (this.running.has(row.id) || this.pending.some(t=>t.row===row)) continue;
      try {
        const parsed=instanceFromUrl(row.url);
        if (ids.has(parsed.id) || this.busyInstances.has(parsed.id)) throw Error('同一实例已在本批次或另一个任务中，请勿重复添加');
        if (row.instanceId && row.instanceId!==parsed.id) row.registered=false;
        row.instanceId=parsed.id;
        if (!row.registered && (!row.token || row.token.length<20)) throw Error('请填写 Gateway Token（至少 20 个字符）');
        ids.add(parsed.id); this.busyInstances.add(parsed.id);
        this.pending.push({row,mode,options:{...options}});
        this.update(row,{state:'queued',message:'已排队'});
      } catch(e) {this.update(row,{state:'failed',message:e.message});}
    }
    this.pump();
  }
  pump() {
    while(this.running.size<this.limit && this.pending.length) {
      const task=this.pending.shift(); this.running.add(task.row.id);
      this.run(task).catch(e=>this.update(task.row,{state:'failed',...(task.row.mcp==='checking'?{mcp:'failed'}:{bridge:'failed'}),message:e.message})).finally(()=>{
        this.running.delete(task.row.id);this.busyInstances.delete(task.row.instanceId);this.changed();this.pump();
      });
    }
  }
  async run({row,mode,options}) {
    if(row.removed)return;
    if(mode==='check' && row.registered){await this.refreshConnection(row);if(!row.jobId)this.update(row,{state:'checked'});return;}
    if(mode==='resume'){await this.syncLatest(row);return;}
    if (row.jobId) {
      if (mode !== 'resume') {
        try {await this.api(`/api/connections/jobs/${encodeURIComponent(row.jobId)}/resume`, {});}
        catch(error) {if (/后台任务已过期/.test(error.message)) this.update(row,{jobId:''});else throw error;}
      }
      if (row.jobId) return this.poll(row);
    }
    if (mode==='resume') {this.update(row,{state:'interrupted',message:'没有可恢复的后台任务，请重新检查'});return;}
    if (!row.registered || (options.replace && row.token)) {
      this.update(row,{state:'registering',message:'正在登记凭据'});
      const result=await this.api('/api/connections/register',{url:row.url,token:row.token,name:row.name,
        replace:options.replace===true,deferHealth:true});
      row.registered=true;row.instanceId=result.instanceId;
    }
    if (mode==='check') {
      this.update(row,{state:'checking',mcp:'checking',approval:null,stale:false,message:'正在检查 MCP'});
      const check=await this.api('/api/connections/mcp/check',{instanceId:row.instanceId});
      if (check.stage==='pairing_required') {
        this.update(row,{state:'approval',mcp:'approval',approval:verifiedPairing(check),message:'MCP 等待设备配对批准，其他实例继续执行'});return;
      }
      if (!check.online) {this.update(row,{mcp:'failed'});throw Error(check.message || 'MCP 未接通');}
      this.update(row,{mcp:'online',message:'MCP 已连接'});
      let bridge='unconfigured',bridgeError='';
      if (row.bridgeConfigured) {
        try {const value=await this.api('/api/actions',{instanceId:row.instanceId,action:'bridge_health'});bridge=value.result?.ok===true?'online':'failed';if(bridge==='failed')bridgeError=value.result?.error || value.message || '';}
        catch(error) {bridge='failed';bridgeError=error.message;}
      }
      this.update(row,{bridge,state:'checked',message:bridge==='failed'?(bridgeError || 'MCP 已连接，文件桥健康检查未通过'):'检查完成'});return;
    }
    this.update(row,{state:'installing',mcp:'checking',bridge:'unknown',approval:null,stale:false,message:'正在自动检查 MCP 并安装文件桥'});
    const result=await this.api('/api/connections/mcp/install-bridge',{
      instanceId:row.instanceId,confirm:true,allowSharedWorkspace:true,enableDelete:options.enableDelete===true});
    if (result.jobId) {this.update(row,{jobId:result.jobId});return this.poll(row);}
    this.finish(row,result);
  }
  finish(row,result) {
    if (['approval_required','pairing_required'].includes(result.stage)) {
      this.update(row,{jobId:'',state:'approval',approval:verifiedPairing(result),
        ...(result.stage==='pairing_required'?{mcp:'approval'}:{}),bridge:'approval',message:result.message || '等待远端批准'});return;
    }
    if (result.stage!=='complete') throw Error('后台未确认安装完成，请重新检查状态');
    this.update(row,{jobId:'',approval:null,state:'complete',mcp:'online',bridge:'online',bridgeConfigured:true,stale:false,
      message:result.message || 'MCP 和文件桥健康检查通过'});
  }
  async poll(row) {
    this.update(row,{state:'installing',message:'正在跟踪后台安装任务'});
    for(let attempt=0;attempt<450;attempt++) {
      if(row.removed)return;
      let response;
      try {response=await this.api(`/api/connections/jobs/${encodeURIComponent(row.jobId)}`);}
      catch(e) {
        if (e.status===404 || /已过期/.test(e.message)) this.update(row,{jobId:''});
        this.update(row,{state:'interrupted',message:e.message+'；可点击本行继续'});return;
      }
      const job=response.job || response;
      if(this.applyJob(row,job))return;
      const mcpReady=['route_check','permission_check','permission_repair','permission_verify','bridge_install','tunnel','verify'].includes(job.stage);
      this.update(row,{...(job.stage==='mcp_check'?{mcp:'checking',bridge:'unknown',stale:false}:mcpReady?{mcp:'online',stale:false}:{}),
        ...(job.stage!=='mcp_check'?{bridge:job.status==='queued'?'unknown':job.approval?'approval':'installing'}:{}),approval:job.approval || null,message:[permissionStageLabel(job.stage),job.logs?.slice(-4).map(e=>e.message).join('\n') || job.message || '正在安装'].filter(Boolean).filter((text,index,items)=>items.indexOf(text)===index).join('\n')});
      await this.sleep(2000);
    }
    this.update(row,{state:'interrupted',message:'后台任务较久，已保留任务编号；点击继续可恢复进度'});
  }
}
