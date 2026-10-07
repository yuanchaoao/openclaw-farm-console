export const PERFORMANCE_PREFERENCE_KEY = 'openclawFarm.batchPerformance.v2';
export function performanceSettings(config = {}, preference = null) {
  const positive = value => Number.isInteger(Number(value)) && Number(value) > 0;
  const maximum = positive(config.maxBatchConcurrency) ? Math.min(100, Number(config.maxBatchConcurrency)) : 100;
  const recommended = positive(config.batchConcurrency) ? Math.min(maximum, Number(config.batchConcurrency)) : maximum;
  const manual = preference?.version === 2 && preference.manual === true && positive(preference.limit);
  const limit = manual ? Math.min(maximum, Number(preference.limit)) : recommended;
  const choices = [...new Set([10,20,50,100,maximum,recommended,limit].filter(value => value <= maximum))].sort((a,b)=>a-b);
  return {maximum,recommended,limit,choices,manual};
}
export function batchCounts(rows) {
  const counts = {total:rows.length,running:0,queued:0,pending:0,complete:0};
  for (const row of rows) {
    if (row.approval || ['approval','awaiting_approval','blocked','failed','interrupted'].includes(row.state) || (row.state === 'checked' && row.bridge === 'failed')) counts.pending++;
    else if (row.state === 'queued') counts.queued++;
    else if (['registering','checking','installing'].includes(row.state)) counts.running++;
    else if (['checked','complete'].includes(row.state)) counts.complete++;
  }
  return counts;
}
