# 安装、运行、更新与卸载

## 下载与环境

下载完整源码 ZIP 并解压，或克隆仓库。源码包含管理台、所有 adapter/MCP/文件桥程序、安装入口、依赖锁、示例和文档。安装过程在线获取官方依赖，源码包不预装第三方二进制，不依赖特定聊天软件安装目录。

macOS/Linux 的 shell 安装入口还需要 curl 或 wget、tar，以及 shasum 或 sha256sum，用于下载、解包和 SHA-256 校验。

使用 shell/PowerShell 安装入口获取本应用所需环境：

~~~sh
sh scripts/install/install.sh
~~~

Windows：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/install.ps1
~~~

也可双击根目录 install.command（macOS）或 install.cmd（Windows）。已有 Python 3.10 或更新版本时使用：

~~~sh
python3 control.py install
~~~

安装使用锁定 Node 22.14.0、Python 3.12.10 与依赖锁。需要可访问官方发布源和包源；网络失败会明确报错，不声称已安装。OpenSSH 客户端与系统原生凭据存储需要当前系统具备；Linux 桌面需要已解锁的 Secret Service 和用户 D-Bus 会话。Node SDK 包锁定 OpenClaw 2026.4.2，不安装远端实例本体。

安装入口提供 macOS/Linux 的 x64、ARM64 架构选择，以及 Windows 10/11 x64、Windows 11 ARM64 路径。Windows 11 ARM64 安装原生 ARM64 Node 和固定版本 x64 Python，需要系统的 x64 模拟支持；不承诺 Windows 10 ARM64。架构选择实现不代表该平台已完成实机验收。

版本下载、架构选择与校验由安装入口负责；临时网络中断后重新运行相同入口会检查现有资产，不能复制他人的运行环境或凭据。平台的实机验收状态见 [验证说明](validation.md)。

## 安装位置与控制

默认安装根目录：

| 平台 | 当前用户目录 |
|---|---|
| macOS | ~/Library/Application Support/OpenClaw Farm Console |
| Windows | %LOCALAPPDATA%/OpenClaw Farm Console |
| Linux | $XDG_DATA_HOME/openclaw-farm-console，默认 ~/.local/share/openclaw-farm-console |

进入实际安装目录，使用该目录的私有 Python 和 control.py；安装器同时生成“打开管理台”“启动管理台”“停止管理台”“查看运行状态”快捷入口。路径有空格时加引号。

~~~sh
./runtime/python/bin/python control.py status
./runtime/python/bin/python control.py open
./runtime/python/bin/python control.py stop
./runtime/python/bin/python control.py start
./runtime/python/bin/python control.py mcp
~~~

Windows 对应使用 .\runtime\python\Scripts\python.exe control.py status 等命令。mcp 是 stdio 服务，通常由客户端启动，运行后等待输入属于正常行为。Console URL 默认为 http://127.0.0.1:4317/；修改端口后用 status 取得实际地址。

隔离安装可指定 --home DIR、--port PORT、--no-start 和 --no-autostart；准确位置以 control.py --help 为准，目录应属于当前用户。不要用另一个用户或管理员身份启动同一份数据。启动前台/自动启动策略随平台实现，最终仍以真实本机 API 服务身份确认启动成功。

## 更新

1. 保存当前未完成任务的 ID 和实际阶段，核对远端是否仍在执行。
2. 下载新的完整发行包，审核发行说明和依赖变化。
3. 运行同一安装入口升级同一个安装目录。已有配置、data、系统凭据与实例身份应保留；安装器保存更新备份。
4. 运行 status，并检查页面配置、登记与原任务。重启后的在途记录先复查实际状态，不自动重发远端安装。
5. 选一个已授权实例进行认证与文件只读核验；有权限时做唯一文件完整验收，再恢复批量工作。

不能用历史输出或新计算哈希重新“批准”程序版本。自有 HTTPS 文件桥来源应与本发行版批准的程序哈希一致。升级失败时保留数据、检查 backups；只恢复程序或确实损坏的层，不能把旧凭据覆盖到新的健康环境。

## 备份

备份自己的 config、data 和必要日志/更新备份，并在原生系统凭据库中使用系统支持的迁移方式处理凭据。SSH 私钥与 adapter 设备身份属于私有材料，受保护存放；不能纳入 Git、Release、公开问题或共享安装包。

复制源码不是业务数据备份。data/instances.json 只存凭据索引，单独恢复它不等于凭据可用；在新系统重新核对实例与授权。迁移设备身份时也要核对远端配对，不能创建两份同时操作同一身份的维护进程。

## 卸载

~~~sh
./runtime/python/bin/python control.py stop
./runtime/python/bin/python control.py uninstall
~~~

卸载应先停本安装服务、移除本安装自动启动入口。默认保留config、data和系统凭据；明确清理本安装时使用 control.py uninstall --purge。该选项先删除登记的Gateway/文件桥原生凭据，失败会中止数据删除。先备份并按 control.py uninstall --help 查看本版本选项。不要手工递归删除不明确的父目录。

本机卸载不代表远端文件桥、反向隧道与中继授权已经撤销。若要彻底移除，另行授权准确实例/用户/端口：先停止对应远端服务及专用隧道，核对没有业务在途，再备份并删除对应中继公钥行，最后清理远端桥资产与本地凭据。其他实例与服务器用户继续保留。完成需分别验证本机服务已停止、远端路径已停、中继行已移除。
