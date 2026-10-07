export function bridgePortClaims(registry,jobs=[],reservations=new Map()) {
  const claims=new Map();
  const add=(id,p)=>{p=Number(p);if(!Number.isInteger(p)||p<1024||p>65535)return;if(!claims.has(p))claims.set(p,new Set());claims.get(p).add(id);};
  for(const [id,record] of Object.entries(registry.instances || {})) {
    const b=record.file_bridge || {};
    for(const key of ['local_port','relay_port'])add(id,b[key]);
    const port=b.base_url?.match(/(?:localhost|127\.0\.0\.1):(\d+)/)?.[1];if(port)add(id,port);
  }
  for(const job of jobs)if(!['complete','failed','archived'].includes(job.status))add(job.instanceId,job.port);
  for(const [id,p] of reservations)add(id,p);
  return claims;
}
export const exclusivelyClaimed=(claims,instanceId,port)=>claims.has(port)&&claims.get(port).size===1&&claims.get(port).has(instanceId);
