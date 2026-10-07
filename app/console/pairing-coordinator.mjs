export class PairingCoordinator {
  constructor(check,{now=Date.now,leaseMs=30*60000}={}){this.check=check;this.now=now;this.leaseMs=leaseMs;this.records=new Map();this.inflight=new Map();}
  async verify(instanceId,{renewLease=true}={}) {
    if(this.inflight.has(instanceId))return this.inflight.get(instanceId);
    const request=(async()=>{
      const old=this.records.get(instanceId),startedAt=old?.startedAt || this.now();
      try {
        const value=await this.check({instanceId});
        const record={...value,instanceId,checkedAt:this.now(),approvalKind:value.online?null:'mac_pairing',startedAt,
          leaseUntil:old?.leaseUntil || (renewLease?this.now()+this.leaseMs:startedAt)};
        // A new explicit check may open another window after the previous window ended.

        if(value.online){delete record.requestId;delete record.deviceId;}
        this.records.set(instanceId,record);return record;
      } catch(error){this.records.delete(instanceId);throw error;}
    })().finally(()=>this.inflight.delete(instanceId));
    this.inflight.set(instanceId,request);return request;
  }
  async tick(){await Promise.allSettled([...this.records.values()].filter(r=>!r.online && r.leaseUntil>this.now()).map(r=>this.verify(r.instanceId,{renewLease:false})));}
}
