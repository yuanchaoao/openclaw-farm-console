# 17 个 MCP 工具参考

来源：app/openclaw-farm/scripts/openclaw_mcp_server.py 的实际 @mcp.tool 定义。所有工具返回字符串：结构化结果一般为 JSON，文本读取返回文本，错误以 [openclaw error] 或 [openclaw file error] 开头。调用者应检查内容，不把工具传输成功误作业务成功。

instance="" 使用登记表默认实例；没有默认值时只允许唯一有效实例。归档实例不能作为自动默认候选。执行批准要求显式实例。秒和毫秒按下表区分。

| 工具 | 输入（默认值） | 能力与门禁 |
|---|---|---|
| openclaw_list_instances | 无 | 脱敏实例、凭据是否存在、文件桥配置；不返回 Token |
| openclaw_sessions_list | instance="", limit=20 | Gateway 会话列表；limit 1–100；不需要文件桥 |
| openclaw_chat_history | session_key, instance="", limit=20 | Gateway 历史；limit 1–100；查看远端结果与已有文件链接 |
| openclaw_chat_send | message, session_key, idempotency_key, instance="", approved=false | 授权任务发送；message 非空且 ≤1.5 MiB；session_key ≤512 字符，idempotency_key ≤256 字符；同一请求重试复用编号；不自动配置存储或 SSH |
| openclaw_exec_approve | request_id, instance, approved=false | 当前任务完整 UUID，明确实例，单次 allow-once；不能批准设备配对或更改执行策略 |
| openclaw_run_bash | cmd, instance="", approved=false, timeout=120 | 远端命令；timeout 为秒；要求准确命令已获授权，远端也可要求执行批准 |
| openclaw_read_file | path, instance="" | 兼容远端读取，优先文件桥；不是大文件传输入口 |
| openclaw_file_list | path=".", instance="" | 列出工作区目录 |
| openclaw_file_stat | path, instance="" | 元数据与普通文件 SHA-256 |
| openclaw_file_read | path, max_bytes=1048576, instance="" | 有大小上限的 UTF-8 文本读取 |
| openclaw_file_write | path, content, instance="", expected_sha256="", approved=false | 原子文本写入；覆盖已存在普通文件须先取当前哈希 |
| openclaw_file_upload | local_path, remote_path, instance="", expected_remote_sha256="", overwrite=false, approved=false | 分块续传、提交校验；本地路径必须绝对；覆盖需明确授权和远端当前哈希 |
| openclaw_file_download | remote_path, local_path, instance="", overwrite=false, approved=false | 续传下载并校验大小和哈希；本地路径必须绝对；覆盖本地文件时 approved=true |
| openclaw_file_move | src, dst, instance="", approved=false | 移动/重命名；目标不能已存在 |
| openclaw_file_copy | src, dst, instance="", approved=false | 复制；目标不能已存在 |
| openclaw_file_delete | path, recursive=false, instance="", expected_sha256="", approved=false | 精确删除目标；目录要 recursive=true，普通文件校验旧哈希；服务还必须启用 delete |
| openclaw_file_mkdir | path, instance="", approved=false | 创建目录，允许父目录；不是整个工作区根目录 |

## 使用示例

~~~json
{"tool":"openclaw_file_stat","arguments":{"instance":"ins_demo01","path":"reports/result.txt"}}
~~~

下面的写入参数只能用于已授权的本次操作；expected_sha256 应替换为上一条 stat 的实际哈希：

~~~json
{"tool":"openclaw_file_write","arguments":{"instance":"ins_demo01","path":"reports/result.txt","content":"approved update\n","expected_sha256":"ACTUAL_CURRENT_SHA256","approved":true}}
~~~

远端路径始终相对于登记工作区；禁止绝对路径、..、符号链接、硬链接文件或跨嵌套挂载。服务范围、用户任务授权和工具 approved 参数三者都要满足。文件桥健康检查只证明文件能力，不证明远端模型可推理。
