export function transientBridgeConnection(error) {
  const message=String(error?.message || error || '');
  return !/HTTP\s+(401|403)|凭据|Token|keychain|钥匙串/i.test(message) &&
    /TimeoutError|timed? out|超时|URLError|ConnectionResetError|RemoteDisconnected|ECONNRESET|ECONNREFUSED|文件桥连接失败/i.test(message);
}
export function shouldRepairExistingBridgeRoute({configured,healthFailure,routeProbeSession}) {
  if(routeProbeSession)return true;
  if(!configured)return false;
  return /文件桥 HTTP 401/.test(String(healthFailure?.message || healthFailure || '')) || transientBridgeConnection(healthFailure);
}
// A historical TUNNEL_READY marker proves only that a tunnel once started.
// Restore the existing route when the live bridge check reports a transport failure.
export async function resumeVerifiedBridgePhase({phaseEvidence,healthFailure,continueSteps,repairRoute}) {
  if(phaseEvidence==='TUNNEL_READY' && transientBridgeConnection(healthFailure))return repairRoute();
  return continueSteps();
}
export async function checkBridgeWithRecovery({instanceId,configured,run,onProgress=()=>{}}) {
  try {return await run(['bridge-health',instanceId],'',[0],45000);}
  catch(error) {
    if(!configured || !transientBridgeConnection(error))throw error;
    onProgress('正在核对并重建此实例独占的 Mac 本地转发',{stage:'local_forward_repair'});
    const result=await run(['bridge-reconnect',instanceId,'--approved-reconnect'],'',[0],45000);
    onProgress('本地转发已恢复，正在核验文件桥实际状态',{stage:'verify'});
    return result;
  }
}
