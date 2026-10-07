# 接口与命令参考

来源为 app/console/server.mjs、app/openclaw-farm/scripts/openclaw_farm.py 与 file_bridge_server.py。接口为本机管理台使用，默认绑定 127.0.0.1，不是公开云服务。HTTP 返回 200/202 或 ok=true 只代表该接口当前结果；远端业务完成要查实际能力/文件及持久状态。

## Console HTTP API

默认地址 http://127.0.0.1:4317。JSON 请求使用 Content-Type: application/json；一般请求体上限 64 KiB，列表在 UI 侧限量。不要把敏感请求体写入终端历史、调试代理或报告。首次配置操作还会检查本机来源；不能经公网转发后当公开 API 使用。

### 设置和状态

| 方法 / 路径 | 输入与作用 |
|---|---|
| GET /api/setup | 返回 config、configured、configFile、activePort |
| POST /api/setup | {config, initialInstance?, complete?}；保存 [配置结构](configuration.md)，可初始登记实例；complete=true 要实际 SSH/Python检查；返回 registration、restartRequired |
| POST /api/setup/ssh-key | {}；创建或复用配置路径中的专用 Ed25519 密钥；返回 created、publicKey，不覆盖已有私钥 |
| GET /api/setup/relay-authorization | 返回 publicKey、当前主机/用户与限制转发范围的服务端授权脚本 |
| POST /api/setup/check-relay | {}；实际 SSH、授权范围及服务器 Python检查；不代替每实例文件桥验收 |
| GET /api/local-status | 服务身份、安装平台/依赖、原生凭据库/中继配置线索与 consoleUrl |
| GET /api/performance | 性能档、Gateway/SSH 并发、当前活跃/排队计数 |
| GET /api/instances | 有效实例、turnCount 和 archivedInstanceIds |

设置示例（没有真实凭据）：

~~~json
{
  "config": {
    "consolePort": 4317,
    "relay": {
      "host": "relay.example.invalid",
      "user": "relayuser",
      "sshPort": 22,
      "identityFile": "/ABSOLUTE/PRIVATE/PATH/openclaw_farm_relay",
      "portRange": [19900, 20080]
    },
    "bridge": {"podPort": 18081, "workspace": "/workspace"},
    "setupComplete": false
  },
  "complete": false
}
~~~

### 实例与任务

| 方法 / 路径 | 输入与作用 |
|---|---|
| POST /api/connections/register | {url,token,name?,replace?,deferHealth?}；凭据通过 stdin/native store 导入；deferHealth 只跳过首次健康，不伪造在线 |
| PATCH /api/instances/:instanceId | {name}；更新显示名，保留稳定 ID |
| POST /api/instances/:instanceId/archive | 归档管理范围；不是远端卸载 |
| POST /api/actions | {instanceId,action,path?,allowNamedInstance?}；action: instance_status、bridge_health、file_list、gateway_sessions |
| POST /api/status-lights | {instanceIds,allowNamedInstance?}；最多 50 个，分别返回 Gateway 与文件桥状态，保护未授权命名实例 |
| POST /api/gateway-chat | {instanceId,operation:"history"|"send",sessionKey?,message?,allowNamedInstance?}；默认 sessionKey 为 agent:main:main；history 最多20条，send 非空且≤12000字符 |
| POST /api/files | {instanceId,operation,path,content?,recursive?,allowNamedInstance?}；operation: list、read、write、mkdir、delete；仅工作区相对路径，read/write 默认1MiB限制 |

file write/delete 会先读取当前 stat，覆盖或删除普通文件时传入当前哈希。目录删除需 recursive=true，不能删除工作区根。UI 请求本身是当前用户操作入口，编程调用者仍需核对真实任务授权。

gateway-chat send 在当前 HTTP 请求中生成自己的 idempotencyKey；HTTP响应不明时先查 history/目标实际结果，不要盲目再次 POST。需要自行持久管理重试编号的自动任务应使用 MCP openclaw_chat_send 或 CLI call chat.send。

### 文件桥连接

| 方法 / 路径 | 输入与作用 |
|---|---|
| POST /api/connections/mcp/check | {instanceId,allowNamedInstance?}；当前身份的真实 Gateway 检查；不自动批准配对 |
| POST /api/connections/mcp/install-bridge | {instanceId,confirm:true,allowSharedWorkspace:true,enableDelete?,allowNamedInstance?,allowInternalPermissionRepair?,forceNewAttempt?}；创建/复用持久任务，通常返回202与jobId |
| GET /api/connections/instances/:instanceId/latest | 最近该实例任务，归档实例返回 archived |
| GET /api/connections/jobs/:jobId | 脱敏任务状态、阶段、日志、结果与缺失证据 |
| POST /api/connections/jobs/:jobId/resume | 当前范围/权限字段；复查原执行和下游结果，再继续缺失步骤 |
| POST /api/connections/file-bridge | {instanceId,baseUrl,token,workspace?,replace?,allowNamedInstance?}；登记已有 direct_http 桥及范围凭据，仍需验收 |
| POST /api/connections/file-bridge/prompt | {instanceId,token,allowNamedInstance?}；手动第一段安装提示词与独占端口 |
| POST /api/connections/file-bridge/authorize | {instanceId,token,port,publicKey,confirm:true,allowNamedInstance?}；精确公钥/端口授权与第二段提示词 |
| POST /api/connections/file-bridge/batch-prompts | {instanceIds,confirm:true}；1–20个数字名称实例，返回 batchId 和各项提示词 |
| POST /api/connections/file-bridge/batch-authorize | {batchId,items:[{instanceId,publicKey}],confirm:true}；逐项授权完整公钥；手动批次约1小时有效 |

allowNamedInstance 与 allowInternalPermissionRepair 是当前任务的明确授权标志，不能用来批准来源不明的远端设备申请。forceNewAttempt 会进入精确旧运行终止/确认流程，仅在已核对原结果并确需新尝试时使用；不是通用超时重试。

install-bridge 的缺失文件桥安装分支在取得完整配对申请 ID/设备 ID 后，会调用本地 pairing-approve-via-responses 辅助命令，以 openclaw:main 沿用该实例主 agent 配置，请求核对并批准该申请原有权限，再复查同一客户端的真实 Gateway。已有健康桥复用分支只检查 Gateway；单独 mcp/check 也不触发自动批准。该尝试依赖远端 /v1/responses 与主 agent 设备批准工具权限，可能使用收费模型；请求接受不代表配对成功，未验通时保留待处理状态和人工入口。详见 [配对教程](first-connection.md)。

典型持久任务字段：id、instanceId、status、stage、createdAt、updatedAt、checkedAt、blockerCode、approvalKind、nextAction、maintenanceSession、remoteRunId、idempotencyKey、missingEvidence、logs。重启后在途任务进入 RESTART_REVIEW_REQUIRED 以核对真实结果；旧批准 ID 不从磁盘直接恢复为有效授权。

### 可选本地聊天集成

GET /api/models、POST /api/chat 与 POST /api/reset-thread 用于本地智能体集成，不属于17个远端MCP工具。需要自己的可用客户端/账号，不携带发行者凭据。远端 Gateway操作与文件桥恢复应使用上面的独立通道。

## 公共控制与 CLI

~~~sh
./runtime/python/bin/python control.py --help
./runtime/python/bin/python control.py install --help
./runtime/python/bin/python control.py uninstall --help
./runtime/python/bin/python control.py farm --help
~~~

公共动作：install、start、stop、status、open、uninstall、mcp、farm。隔离安装参数必须置于 farm 前，例 control.py --home /PRIVATE/INSTALL farm list。

adapter 子命令：

| 类别 | 命令 |
|---|---|
| 登记 | register --instance-id ID --url URL；隐藏输入，或受保护 --token-stdin；--metadata-only 仅登记元数据，--replace明确更换已有凭据 |
| 只读状态 | list、status ID、verify ID [--timeout MS] [--no-save]、chat-url ID |
| Gateway RPC | call ID METHOD --params-json '{}' --timeout MS；非只读 method要 --allow-write |
| 单条配对辅助 | pairing-approve-via-responses ID REQUEST_UUID DEVICE_ID --timeout SECONDS；经授权请求对应主 agent 核对并批准原 scopes，完成仍须 verify |
| 桥配置 | bridge-configure ID --transport ssh_relay|direct_http；ssh_relay需local-port/relay-host/relay-user/relay-port/relay-key，relay-ssh-port默认22 |
| 桥凭据 | bridge-secret ID --scope read|write|delete|all；隐藏输入，--replace明确更换 |
| 桥检查/恢复 | bridge-status ID、bridge-health ID、bridge-reconnect ID --approved-reconnect |
| 文件只读 | file-list ID [PATH]、file-stat ID PATH、file-read ID PATH --max-bytes N |
| 文件写 | file-write ID PATH --content-file LOCAL 或 --content-stdin，--expected-sha256 HASH --approved-write |
| 传输 | file-upload ID LOCAL REMOTE --chunk-size N --approved-write；file-download ID REMOTE LOCAL；覆盖和禁用续传选项见 [教程](files.md) |
| 修改/删除 | file-mkdir、file-move、file-copy：--approved-write；file-delete：--approved-delete，目录还需--recursive |
| 远端命令 | run-bash ID COMMAND --timeout SECONDS --approved-write；远端read兼容：read-remote-file ID PATH |

Gateway timeout 单位为毫秒；run-bash 和 pairing-approve-via-responses 为秒。配对辅助是 CLI 管理入口，不增加第 18 个 MCP 工具。CLI 可能为特定管理通道提供更多命令，以本发行版 --help 为准；高权限配对辅助入口不能替代准确身份核验与用户授权。

## 文件桥 V2 HTTP API

文件桥只绑定回环。每个请求需 X-OpenClaw-Token（含 read/write/delete 范围）；不要使用URL查询串传凭据。JSON错误携带稳定 code 和 requestId；大文件下载为二进制。

| 方法 / 路径 | 范围 | 内容 |
|---|---|---|
| GET /v1/health | read | 健康与版本 |
| GET /v1/capabilities | read | 支持能力、启用模式与限制 |
| GET /v1/list?path=... | read | 目录项 |
| GET /v1/stat?path=... | read | 元数据、普通文件sha256 |
| GET /v1/read?path=...&max_bytes=... | read | 受限UTF-8文本 |
| GET /v1/download?path=... | read | 二进制，支持单Range |
| POST /v1/write | write | {path,content,expected_sha256?}；原子写、覆盖版本核验 |
| POST /v1/mkdir | write | {path,parents:true} |
| POST /v1/move、/v1/copy | write | {src,dst}；目标不得已存在 |
| POST /v1/delete | delete | {path,confirm:同一相对路径,recursive?,expected_sha256?} |
| POST /v1/uploads | write | {path,total_size,sha256,expected_sha256?} → upload_id、offset |
| GET /v1/uploads/:id | read | 当前已保存offset与total_size |
| PUT /v1/uploads/:id | write | 二进制块，X-Upload-Offset必须等于当前偏移 |
| POST /v1/uploads/:id/commit | write | {sha256?}；完整大小/哈希验证后原子提交 |
| DELETE /v1/uploads/:id | write | 放弃未提交的上传，清理对应暂存资产 |

默认 JSON/read 1MiB、chunk 16MiB、file/download 64GiB、目录项5000、worker8、socket timeout30秒；部署可通过服务参数降低/调整。客户端应读取 capabilities，不能假设上限未变。

旧无 /v1 前缀的基础路由只为兼容，新增集成使用 /v1。状态码409可能是版本冲突、目标已存在、偏移不一致、大小或哈希不符；先读取现状，不通过重复POST或删除目标绕过。
