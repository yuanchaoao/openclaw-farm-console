# OpenClaw Farm Console

一个在自己电脑运行的 OpenClaw 实例管理台：登记与配对 Gateway、独立会话任务、批量接通文件桥、通过 SSH 中继读写文件、断点续传，以及按实际状态恢复连接。网页默认只监听 http://127.0.0.1:4317/ 。

此仓库提供完整的管理台、CLI、17 个 MCP 工具、文件桥服务、安装入口和文档。安装时从官方软件源获取锁定依赖；下载包不携带 Node/Python 运行环境、实例凭据、SSH 私钥、聊天、运行数据或个人配置。远端仍运行用户自己的 OpenClaw，本机管理台不替代远端服务。

## 从下载到第一次连接

1. 下载 GitHub Release 的完整源码包，或在仓库页面选择 Code → Download ZIP，解压到自己可写的目录。
2. 确认系统有 OpenSSH 客户端和原生凭据库。Linux 桌面需要已解锁的 Secret Service；macOS 使用登录钥匙串，Windows 使用凭据管理器。
3. 在解压目录运行安装入口，自动获取锁定的 Node/Python 环境：

~~~sh
sh scripts/install/install.sh
~~~

Windows 可使用：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/install.ps1
~~~

也可双击 install.command（macOS）或 install.cmd（Windows）。已有 Python 3.10+ 时可使用 python3 control.py install；安装后双击安装目录的“打开管理台”入口，或使用该目录的 ./runtime/python/bin/python control.py open（Windows：.\runtime\python\Scripts\python.exe control.py open）。

4. 页面首次配置中填写自己可 SSH 登录的 Linux 中继服务器、用户与 SSH 端口，创建或选择管理台专用 SSH 密钥。按照生成的授权内容，在中继完成公钥授权和 OpenSSH 转发设置。
5. 在连接中心添加自己的实例链接、Gateway Token 与名称，等待保存完成。先选择一个实例执行“检查并连接 MCP”。
6. 明确本次文件桥写入、共享工作区兼容模式和删除权限后，启动“一键安装 / 修复”。安装缺失文件桥时，如检测到完整配对申请 ID 和设备 ID，管理台会通过该实例的 Responses 入口请求主 agent 核对身份并批准原有权限，再以当前电脑身份复查真实 Gateway 健康。远端需支持该入口及设备批准工具；调用可能产生远端模型费用。
7. 如自动配对未验通，或正在复用已有健康文件桥，按页面提示在对应实例核对完整申请 ID、设备身份和权限后批准，再检查并继续原任务。只有远端服务、中继、本地转发以及测试文件写入、读回、删除全部通过，才能记为完成。

详细步骤见 [安装与卸载](docs/installation.md)、[首次配置](docs/configuration.md)、[中继配置](docs/relay.md) 和 [首次连接教程](docs/first-connection.md)。安装错误、系统凭据存储不可用、远端权限不足等会留下明确的待处理状态；进程存在或安装请求已发送不代表连接成功。

## 能做什么

- 每实例保存独立身份、凭据索引、任务与端口；URL 查询串和片段不入登记表。
- Gateway 提供会话列表、聊天历史与授权任务发送；文件桥提供工作区列表、文本读写、目录创建、复制、移动、删除及文件传输。
- 默认批量处理显示名称为纯数字的实例。命名实例需要本次任务明确授权，不能通过批量选择静默扩围。
- 文件上传以分块偏移恢复，下载以部分文件恢复，最终校验字节数和 SHA-256；覆盖要求当前远端文件哈希。
- 恢复先验证下游实际状态，只补失效的一层。迟到的维护回执、监听端口或日志标记不能单独判定成功或失败。
- 同一源码提供 macOS、Linux、Windows 安装与前台控制入口；各平台的完整环境与实机验收状态见 [验证说明](docs/validation.md)。

## MCP 客户端

支持启动 stdio MCP 服务的客户端可以直接使用安装目录的根入口：

~~~json
{
  "mcpServers": {
    "openclaw-farm": {
      "command": "/ABSOLUTE/INSTALL/PATH/runtime/python/bin/python",
      "args": ["/ABSOLUTE/INSTALL/PATH/control.py", "mcp"]
    }
  }
}
~~~

Windows 的 command 使用安装目录下 runtime\python\Scripts\python.exe 的绝对路径，args 为 ["C:\\ABSOLUTE\\INSTALL\\PATH\\control.py", "mcp"]。不要在 MCP 配置中加入 Token；启动入口会加载本用户配置并读取系统凭据库。WorkBuddy 等客户端按其 stdio/MCP 服务设置导入同样的 command 和 args，具体字段名称以客户端为准。连接后先运行 openclaw_list_instances，检查实例身份再选择工具。见 [MCP 接入](docs/mcp.md) 和 [17 工具参考](docs/mcp-tools.md)。

## 文档导航

| 需要完成的工作 | 文档 |
|---|---|
| 下载、安装、更新、备份、卸载 | [安装与生命周期](docs/installation.md) |
| 配置字段、数据目录与凭据 | [配置参考](docs/configuration.md) |
| 任何供应商的 Linux SSH 中继 | [中继配置](docs/relay.md) |
| 登记、配对、独立会话、文件桥验收 | [首次连接](docs/first-connection.md) |
| 数字实例批量与批准种类 | [批量操作](docs/batch.md) |
| 文本 CRUD、分块上传与下载 | [文件操作](docs/files.md) |
| 中断、超时、隧道与权限恢复 | [恢复工作流](docs/recovery.md) |
| Console HTTP、CLI 与文件桥 HTTP 接口 | [接口参考](docs/api.md) |
| 原理、边界与目录结构 | [架构](docs/architecture.md) |
| 软件来源、版本、依赖许可 | [第三方说明](THIRD_PARTY_NOTICES.md)、[依赖清单](docs/dependencies.md) |

## 项目与许可

本项目自己的代码和文档按 [MIT License](LICENSE) 发布，Copyright (c) 2026 yuanchaoao。OpenClaw、MCP SDK、Boto3 与其依赖保留各自许可；本项目不是 OpenClaw 或任何云供应商的官方产品。中继只使用通用 OpenSSH，不需要 Oracle Cloud SDK、云 API、云账号或任何指定供应商。

提交问题时请提供系统、Node/Python 版本、已脱敏的步骤与错误；不要上传实例 Token、密钥、完整配置数据或聊天记录。有关当前验证范围和仍需实机证据的项目，请看 [验证说明](docs/validation.md)。
