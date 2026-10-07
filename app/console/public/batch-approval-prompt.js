import {pairingFresh} from './pairing-lifecycle.js';
import {instanceFromUrl} from './batch-connection-core.js';
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function approvalPrompt(row){
 const a=row.approval;if(!a)return '';
 let parsed;try{parsed=instanceFromUrl(row.url);}catch{return '';}
 if(parsed.id!==row.instanceId)return '';
 const header=`目标实例：${parsed.id}\n实例链接：${parsed.url}\n只在此实例操作；如果当前 Gateway 不是这个实例，请停止。`;
 if(a.stage==='exec_approval_required'){
  if(!a.error || !uuid.test(a.requestId||'') || !String(a.sessionKey||'').startsWith(`agent:main:openclaw-control-ui:filebridge-${parsed.id.slice(4)}-`))return '';
  return `${header}\n维护会话：${a.sessionKey}\n请核对本次文件桥安装的待执行命令，仅批准该命令一次，并继续原维护会话；不要重复安装。\n/approve ${a.requestId} allow-once`;
 }
 if(!pairingFresh(a))return '';
 const device=/^[a-f0-9]{64}$/i.test(a.deviceId||'')?`\nMac 设备 ID：${a.deviceId}`:'';
 return `${header}${device}\n请在 4 分钟内处理；超过时间请回管理台重新复制。请先确认命令连接的是正在运行的 Gateway，且执行用户与 OPENCLAW_STATE_DIR 与该 Gateway 一致，再核对这台电脑 的待处理设备配对或权限升级申请。不要把 CLI 的空本地回退列表当作目标 Gateway 的结果。${uuid.test(a.requestId||'')?`仅批准编号 ${a.requestId}，并核对设备信息。\nopenclaw devices approve ${a.requestId}`:'Gateway 未提供完整申请编号，请先查看待处理设备列表并核对 Mac 设备信息，不要猜测编号。'}\n若编号已更新，请按上述 Mac 设备 ID 核对最新待处理申请，仅批准该设备对应申请。若仍为空，请返回实际 Gateway 地址、运行用户、状态目录与查询方式（不要输出 Token），不要直接断言 Mac 没有提交。`;
}
export function allApprovalPrompts(rows){return rows.map(approvalPrompt).filter(Boolean).join('\n\n──────── 下一个实例 ────────\n\n');}
