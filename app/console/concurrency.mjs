// Bound expensive local client processes independently of remote task count.
export function concurrencyLimit(value, fallback, maximum=64) {
  const number=Number(value);
  return Number.isInteger(number) && number>0 ? Math.min(number,maximum) : fallback;
}
export function createWorkPool(limit) {
  const maximum=concurrencyLimit(limit,1);let active=0;const waiting=[];
  function pump() {
    while(active<maximum && waiting.length) {
      const {task,resolve,reject}=waiting.shift();active++;
      Promise.resolve().then(task).then(resolve,reject).finally(()=>{active--;pump();});
    }
  }
  return {
    run(task){return new Promise((resolve,reject)=>{waiting.push({task,resolve,reject});pump();});},
    get active(){return active;},get queued(){return waiting.length;},limit:maximum
  };
}
