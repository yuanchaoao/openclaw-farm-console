export const NUMERIC_INSTANCE_NAME = /^\d+$/;

export function isBatchEligibleInstance(instance) {
  return NUMERIC_INSTANCE_NAME.test(String(instance?.name || "").trim());
}

export function requireInstanceAuthorization(instance, options = {}) {
  if (isBatchEligibleInstance(instance) || options.allowNamedInstance === true) return instance;
  const error = new Error(`实例“${instance?.name || instance?.id || "未知"}”是受保护的命名实例；只有主人在当前任务中明确授权该实例后才能调用`);
  error.code = "NAMED_INSTANCE_AUTHORIZATION_REQUIRED";
  error.instanceId = instance?.id || "";
  error.instanceName = instance?.name || "";
  throw error;
}
