# 第一个实例的完整教程

下列 CLI 在安装目录执行，使用安装器准备的私有 Python；Windows 将 ./runtime/python/bin/python 替换为 .\runtime\python\Scripts\python.exe。

先完成 [安装](installation.md)、[首次配置](configuration.md) 与 [中继授权](relay.md)。教程示例实例 ins_demo01 与 gateway.example.invalid 均为虚构占位，必须替换成自己的服务。

## 登记与身份

在连接中心输入自己的 HTTPS/WSS 链接、Gateway Token、显示名。URL 形状为 https://gateway.example.invalid/ins_demo01/chat。实例 ID 来自路径；显示名用于管理，数字名称可以进入批量范围。

页面等待“已保存”后读取当前登记状态。Token 存入本系统原生凭据库。仅保存/登记成功还不能认为远端在线。CLI 也支持隐藏输入，不把 Token 放入参数：

~~~sh
./runtime/python/bin/python control.py farm register --instance-id ins_demo01 --url https://gateway.example.invalid/ins_demo01/chat
./runtime/python/bin/python control.py farm status ins_demo01
~~~

## Gateway 配对

“检查并连接 MCP”使用当前电脑的既有设备身份检查真实 Gateway；它本身不自动批准设备。返回 pairing required 时保留完整申请 ID、设备 ID 和请求权限。

安装缺失文件桥时，经本次安装写入与共享工作区授权的“一键安装 / 修复”会尝试自动配对：使用登记实例的原生凭据调用该实例 /v1/responses，请求其主 agent 查询当前申请，仅在完整申请 ID 与设备 ID 相符时批准该条申请的原有权限，不扩大范围。管理台随后仍以当前电脑的同一身份复查 Gateway；HTTP 接受或 agent 文本不能代替实际连接通过。

这一尝试使用 openclaw:main，沿用该实例主 agent 的模型配置；需要远端 Responses 入口可用，且主 agent 具有查询和批准设备的实际工具权限，调用可能产生远端模型费用。已配对设备直接复用；已有健康文件桥的复用分支只核验 Gateway，不触发此自动批准。自动路径未验通或需要手动处理时：

1. 保留本机已生成的设备身份与同一发起调用。
2. 在对应远端实例核对完整配对请求 ID、设备公钥/身份和请求 scopes。
3. 由已获授权的远端用户/入口批准这一条请求；不能批准任意队列首条、缩写 ID 或其他实例申请。
4. 使用同一客户端再次检查认证 health，再列出会话。

~~~sh
./runtime/python/bin/python control.py farm verify ins_demo01 --timeout 30000
./runtime/python/bin/python control.py farm call ins_demo01 sessions.list --params-json '{"limit":20}'
~~~

Gateway Token、设备配对、远端内部客户端权限与命令执行批准分别核验，不能用一个状态替代另一个。自动批准实现不等于每个远端部署均已验通；当前实例真实 Gateway 可用后，安装流程才继续依赖它的文件桥步骤。

## 独立会话任务

使用 openclaw_sessions_list 查当前工作；新维护任务有自己的 sessionKey 与 idempotencyKey。通过 chat.send 发送后查看 chat.history 和实际产物。不要把 ACK/runId 当任务成功。正在运行的业务任务要继续时，使用正常 chat.send 排队；sessions.steer 可能中断当前工作。

任务会使用远端实际配置模型，可能产生服务费用；管理台不会预设“远端模型免费”或无用户授权代替调用。

## 文件桥安装

选中该实例并明确允许本次远端安装写入。页面的共享工作区兼容模式意味着使用现有实例工作区；它不等同于隔离挂载。仅需要读取时选择相应服务范围；需要删除时明确启用并授权验收清理。

“一键安装 / 修复”按以下顺序：

1. 验证现有 Gateway 与远端文件桥；健康程序直接复用。缺失文件桥安装分支按上面的条件尝试自动配对，再复查 Gateway。
2. 从校验过的 bundled 程序安装缺失资产，或从用户自行配置的 HTTPS 来源下载并校验。
3. 使用独立维护会话创建/核对远端回环服务与专用隧道公钥。
4. 核对公钥与端口，完成中继对应授权行。
5. 验证远端 -R、中继回环能力、本机 -L 与实际目标。
6. 使用唯一文件写入、读回、删除并保存结果。

程序、凭据文件、运行状态和暴露工作区应分开。文件桥的 Token 文件须为运行用户拥有的普通文件、权限 0600，不能放在桥暴露的工作区内。

## 手动接入已有桥

已经拥有经过核验的文件桥时，用 CLI 登记自己的 SSH 传输，不安装第二个服务：

~~~sh
./runtime/python/bin/python control.py farm bridge-configure ins_demo01 --transport ssh_relay --local-port 20080 --pod-port 18081 --relay-host relay.example.invalid --relay-user relayuser --relay-ssh-port 22 --relay-port 20080 --relay-key /PRIVATE/CLIENT/KEY --workspace /workspace
./runtime/python/bin/python control.py farm bridge-secret ins_demo01 --scope all
./runtime/python/bin/python control.py farm bridge-health ins_demo01
~~~

bridge-secret 隐藏输入匹配服务的凭据。登记配置成功是 configured_unverified，真实 capabilities 和文件验收后才可报告可用。direct_http 仅用于已有可信 HTTPS 网关或本机回环，不能猜测公开路径、开放未鉴权公网端口或扫描端口。

## 验收记录

记录当前实例 ID、各层能力、实际工作区、测试唯一文件路径、字节数/哈希、读回一致、删除成功，以及时间和下一入口。未完成步骤保留待处理状态；不引用其他实例或历史环境的验收为当前实例背书。
