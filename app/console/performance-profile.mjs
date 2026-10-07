import { availableParallelism, totalmem } from 'node:os';

const GIB = 1024 ** 3;
const MAX_BATCH = 100;
const RELAY_PORT_CAPACITY = 181;

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resource-based defaults, not a throughput benchmark. Gateway/SSH limits bound
 * local work; batchConcurrency bounds active instance workflows, most of which
 * may be waiting for their remote main-agent session or the next status poll.
 */
export function getPerformanceProfile({
  totalMemoryBytes = totalmem(),
  parallelism = availableParallelism(),
  mode = 'speed',
} = {}) {
  if (mode !== 'speed') throw new Error('不支持的并发模式。');

  const memoryGiB = positiveNumber(totalMemoryBytes, 2 * GIB) / GIB;
  const cores = Math.max(1, Math.floor(positiveNumber(parallelism, 1)));
  const gatewayConcurrency = Math.max(2, Math.min(32, cores * 2, Math.floor(memoryGiB * 4 / 3)));
  const sshConcurrency = Math.max(1, Math.min(10, cores, Math.floor(memoryGiB / 2)));
  const maxBatchConcurrency = Math.max(1, Math.min(
    MAX_BATCH, RELAY_PORT_CAPACITY, Math.floor(memoryGiB * 5), cores * 10,
  ));
  const batchConcurrency = maxBatchConcurrency;
  const totalMemoryGiB = Math.round(memoryGiB * 10) / 10;

  return {
    mode,
    totalMemoryGiB,
    availableParallelism: cores,
    gatewayConcurrency,
    sshConcurrency,
    batchConcurrency,
    maxBatchConcurrency,
    relayPortCapacity: RELAY_PORT_CAPACITY,
    labels: {
      mode: '速度优先',
      machine: `本机 ${totalMemoryGiB} GiB 内存，${cores} 个可用处理器`,
      local: `本地最多同时处理 ${gatewayConcurrency} 路 MCP / Gateway 请求、${sshConcurrency} 路 SSH 连接操作`,
      batch: `最多同时跟进 ${maxBatchConcurrency} 个实例的配置进度`,
      explanation: '实例在远端主 agent 会话中执行安装；等待远端结果时，本机可继续处理其他实例。',
      limitation: '以上为本机并发建议，实际完成速度取决于远端负载和网络；可用隧道端口也会限制新增实例数量。',
    },
  };
}
