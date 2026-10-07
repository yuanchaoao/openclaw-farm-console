export const isArchived = record => Boolean(record?.console_archived_at);

export function requireActiveRecord(registry, instanceId) {
  const record = registry.instances?.[instanceId];
  if (!record) throw Object.assign(Error('实例不存在或尚未注册'), {code:'INSTANCE_NOT_FOUND'});
  if (isArchived(record)) throw Object.assign(Error('该实例已从管理列表移出；已停止检查和安装，历史记录仍保留'), {code:'INSTANCE_ARCHIVED'});
  return record;
}

export function archiveRecord(registry, instanceId, now = Date.now()) {
  const record = registry.instances?.[instanceId];
  if (!record) throw Object.assign(Error('实例不存在或尚未注册'), {code:'INSTANCE_NOT_FOUND'});
  if (!isArchived(record)) {
    record.console_archived_at = now;
    record.console_archive_reason = 'user_removed_from_ui';
  }
  return record.console_archived_at;
}

export function archiveJob(job, archivedAt) {
  job.archivedAt ||= archivedAt;
  job.previousStatus ||= job.status;
  job.status = 'archived';
  job.blockerCode = 'INSTANCE_ARCHIVED';
  job.approvalKind = null;
  delete job.approval;
  job.nextAction = '已移出当前管理列表，历史记录保留';
  job.message = job.nextAction;
  return job;
}
