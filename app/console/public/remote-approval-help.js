export function remoteApprovalHelp(instanceId){
 if(!/^ins_[a-z0-9]+$/i.test(instanceId||''))throw Error('请先选择已登记实例');
 return `目标实例：${instanceId}
请先核对此实例的当前连接和维护会话实际结果。若文件桥安装返回远端内部错误：Exec approval registration failed / ws://127.0.0.1:18789 / pairing required。
请核对正在运行的 Gateway 所属容器、用户和实际 OPENCLAW_STATE_DIR。查询该 Gateway 的待处理设备，不要使用旧消息中的申请编号，也不要把已在线的 Mac 再次当作待配对设备。
请核实 exec 审批客户端使用的本机设备 ID，与待处理 Linux repair 请求逐项比对；通过主 agent 的只读工具核对实际磁盘设备身份及公钥，与当前 Gateway 记录匹配；只展示设备 ID、公钥指纹、平台、角色、作用域，不展示私钥或 Token。不能仅凭 Linux 平台或请求出现顺序判断身份。
只有确认属于当前 Gateway 的内部审批客户端、请求权限在该设备既有批准范围内后，才通过正常设备批准流程处理该请求。不得关闭配对、放宽全局审批或手工篡改 paired.json；不能确认身份时停下并返回具体缺失信息。
若需要新增权限，请列出精确权限差集并等待用户确认，不要自动扩权。完成后用无副作用的命令验证 exec 审批可以正常提交，并报告结果。不要重复安装文件桥或修改业务文件。`;
}
