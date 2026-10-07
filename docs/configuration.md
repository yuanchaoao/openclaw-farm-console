# 首次配置与配置参考

打开 http://127.0.0.1:4317/setup.html。配置属于当前用户，保存在安装目录的 config/local.json；通过页面保存时会与安装生成的 node、python、environment 合并，不要用一个示例文件覆盖整个安装配置。

## 页面字段

| 字段 | 含义 / 默认值 |
|---|---|
| consolePort | 本地网页端口，默认 4317；允许 1024–65535，更改后重启 Console |
| relay.host | 自有 Linux OpenSSH 中继主机；必须填写，没有公共默认主机 |
| relay.user | 中继 SSH 登录用户；必须填写 |
| relay.sshPort | 中继 SSH 服务端口，默认 22 |
| relay.identityFile | 管理台专用本地 Ed25519 私钥绝对路径；默认本用户 .ssh/openclaw_farm_relay |
| relay.portRange | 两个 1024–65535 端点组成的闭区间，默认 [19900,20080]，最多 256 个端口；不能与现有实例冲突 |
| bridge.podPort | 远端回环文件桥端口，默认 18081 |
| bridge.workspace | 远端实例工作区，默认 /home/node/.openclaw/workspace；允许绝对路径中的字母、数字、下划线、点、短横线与斜线，禁止 .. 路径段；必须核对实际部署 |
| setupComplete | 完成首次配置标记；不代表远端文件桥已验收 |

首次配置可以登记 initialInstance，包括自己的 url、token、name 和 replace。Token 通过本机回环请求进入原生系统凭据库，不保存到配置或浏览器持久缓存。替换已有凭据须明确选择 replace；常规修复不轮换健康凭据。

## 环境变量

公共安装入口从本用户配置加载以下变量。路径变量由安装器生成，一般不需要手工填写。

| 变量 | 用途 |
|---|---|
| OPENCLAW_CONFIG_FILE | 当前 config/local.json |
| OPENCLAW_UI_PORT | 本地网页端口 |
| OPENCLAW_UI_DATA_DIR | Console 业务状态目录 |
| OPENCLAW_INSTANCES_FILE | data/instances.json 登记表 |
| OPENCLAW_ADAPTER_STATE_DIR | data/farm-adapter 设备身份与传输状态 |
| OPENCLAW_FARM_SCRIPT | adapter CLI 路径 |
| OPENCLAW_PYTHON_BIN、OPENCLAW_NODE_BIN | 本安装 Python 与 Node |
| OPENCLAW_PACKAGE_ROOT | 锁定 OpenClaw npm 包目录 |
| OPENCLAW_KEYCHAIN_BIN | 原生系统凭据辅助程序 |
| OPENCLAW_RELAY_HOST、OPENCLAW_RELAY_USER | 中继主机和用户 |
| OPENCLAW_RELAY_SSH_PORT、OPENCLAW_RELAY_KEY | 中继 SSH 端口和专用私钥路径 |
| OPENCLAW_BRIDGE_PORT_MIN、OPENCLAW_BRIDGE_PORT_MAX | 实例独占端口范围 |
| OPENCLAW_BRIDGE_POD_PORT、OPENCLAW_BRIDGE_WORKSPACE | 远端文件桥端口与根目录 |
| OPENCLAW_FILE_BRIDGE_INSTALL_MODE | 默认 bundled，使用本包校验过的程序；可选 r2 为自有 HTTPS 来源 |
| OPENCLAW_FILE_BRIDGE_R2_URL、OPENCLAW_FILE_BRIDGE_R2_SHA256 | 可选自有 HTTPS 程序地址与对应批准哈希，不含 Token |
| OPENCLAW_MAINTENANCE_MODEL | 可选远端维护模型；未设置时使用该实例主agent的实际配置，不指定固定提供商 |
| CODEX_BIN | 可选本地智能体聊天集成所用可执行程序；Gateway/MCP/文件操作不以它代替远端凭据 |

兼容读取旧版 OPENCLAW_ORACLE_* 名称仅为迁移已有用户配置；新安装使用 OPENCLAW_RELAY_*。历史名称不表示 Oracle 云依赖。不要把 Token、密码或 SSH 私钥正文放进环境配置。

## 数据和凭据

安装根目录默认为 macOS 的本用户 Application Support/OpenClaw Farm Console、Windows 的 LOCALAPPDATA/OpenClaw Farm Console、Linux 的 XDG_DATA_HOME/openclaw-farm-console（未设置时 ~/.local/share/openclaw-farm-console）。

- config：本机可执行路径、端口与中继元数据。
- data/instances.json：无 Token 的实例登记表与 credential_ref 索引。
- data/farm-adapter：本用户设备身份和传输恢复状态；其中身份材料应作为私有数据备份。
- data：会话索引、持久连接任务。
- logs、backups：运行日志与更新备份；审核脱敏后才可分享。
- 系统凭据库：macOS Keychain、Windows Credential Manager、Linux Secret Service，分别存 Gateway 与文件桥范围凭据。

原生凭据库不可用时会报错，不退回明文文件。Linux 无桌面/无 D-Bus 会话的机器需要先提供可用的当前用户 Secret Service，不能用明文“临时配置”绕过。SSH 私钥保存在本用户受保护文件，公钥才可提交到中继。

登记表参考 [instances.example.json](../examples/instances.example.json)，环境与设置参考 [local.example.json](../examples/local.example.json)。这些是脱敏结构示例，状态故意为未验证；不能通过改 status 字段制造健康证据。
