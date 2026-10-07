# 验证范围与证据

平台实现、静态检查、自动化测试和用户环境端到端验收是不同证据。本页不以历史环境结果为公开发行版保证，也不根据 README 宣称测试通过。

## 当前验收矩阵

| 场景 | 当前公开文档状态 | 完成需要的证据 |
|---|---|---|
| macOS ARM64 隔离安装 | 本机完整原生门禁通过；首次 GitHub CI 并发回归失败，修复复验中 | 本机报告已保存；最终发行提交仍需对应 CI 完整报告 |
| macOS Intel 全新安装 | 首次 macOS 15 Intel 原生 CI 通过 | 已取得首次提交报告；最终发行提交需对应完整报告 |
| Linux x64 桌面全新安装 | 首次 Ubuntu 24.04 x64 原生 CI 通过 | CI Secret Service 与完整生命周期已验；具体用户桌面仍按实际环境核验 |
| Linux ARM64 桌面全新安装 | 待实机记录 | 原生依赖获取、用户 Secret Service、完整生命周期 |
| Windows Server 2022 x64 原生 CI | 首次安装器模块缺失，修复复验中 | 修复后的同提交完整原生门禁报告 |
| Windows 10/11 x64 全新安装 | 待具体桌面环境验证 | 在线依赖获取、OpenSSH、凭据管理器、生命周期与路径；Server CI 不能代替全部桌面版本验收 |
| Windows 11 ARM64 全新安装 | 待实机记录 | x64 模拟 Python、原生 ARM64 Node、凭据管理器与生命周期 |
| WorkBuddy stdio MCP 接入 | 待具体客户端版本验证 | 客户端启动服务、17 工具发现、真实只读调用 |
| Responses 自动设备配对 | 已提供条件化实现；待用户远端逐实例验收 | 对应实例完整申请/设备 ID、原权限、同一客户端真实 Gateway 连通；夹具和 HTTP 接受不等于验通 |
| 自有 Linux 中继与远端实例 | 每个部署单独验收 | 身份、授权行、三段回环路径、能力响应 |
| 远端文件读写删除与续传 | 每实例/每权限范围验证 | 唯一文件 roundtrip、清理、字节数与哈希 |
| 模型实际推理 | 本安装健康检查不执行 | 用户另行授权的真实调用与结果 |

自动化测试结果如已由本发行版执行，应在发行说明中列出精确命令、平台、时间与结果。未运行的检查保持“未运行/待验证”；不得将构建成功或服务 health 等同于远端文件验收。

## 已取得的本发行版证据

2026-10-07 在 macOS ARM64 使用安装器固定的 Node 22.14.0、Python 3.12 环境，最终执行 app/macos/test-*.mjs 的全部 39 个 JavaScript 测试文件，共 207 项通过，0 项失败、0 项跳过。测试使用隔离目录和合成 Gateway/实例/中继数据。

完整隔离原生检查的复现入口（启动入口使用 Python 3.12）：

~~~sh
python scripts/ci_native.py
~~~

脚本安装固定运行时，使用安装内的 Node/Python 和官方 SDK，为每个 JavaScript 文件配置独立 HOME、配置与实例目录，并以 4 个文件并发执行。它还执行 Python 测试以及安装、升级、卸载门禁；整套门禁完成后才生成 native-summary.json。

本轮 Mac 隔离安装还已完成原生登录钥匙串的实际写入、读取、删除，以及公开 control.py mcp 入口的 stdio initialize、tools/list，返回完整 17 工具。官方 OpenClaw 2026.4.2 SDK 回环测试通过握手、health/status、sessions.list 和 chat.send 协议检查；没有连接生产实例或调用真实模型。

2026-10-07 本机 macOS ARM64 完整中文/空格路径原生门禁已通过，保存了 before-upgrade.json、after-upgrade.json 和 native-summary.json。升级前报告于 08:58:46 UTC 完成 9 项检查；升级后报告于 09:05:11 UTC 完成 11 项检查，包括安装身份、配置/任务与原生凭据保留及凭据删除。汇总报告确认公开安装入口、升级、卸载和保留用户数据均通过，39 个 JavaScript 测试文件执行完成。页面资源、自定义端口、17 工具发现、打开页面、停止/重启及未验证中继不会伪造配置完成，也已实际核验。

上述是本机原生结果。首次 GitHub CI 已取得 Linux x64 与 macOS Intel 的完整通过证据；Windows 安装器模块缺失及 macOS ARM64 并发回归失败正在修复复验。首次结果不能预先证明待推送的修复或最终发行提交已通过。

## 发行 CI 记录位置

首次实际记录为提交 40f6245 的 [Actions run 37599631279](https://github.com/yuanchaoao/openclaw-farm-console/actions/runs/37599631279)。下表只记录该次已取得的结果；修复后的结果须由新的实际记录更新。部分步骤通过、取消或超时不能填写为整套通过。

| 原生 CI 平台 | 发行提交 / Actions run | 实际结果 / 证据制品 |
|---|---|---|
| macOS ARM64（macos-15） | 40f6245 / 37599631279 | 并发回归失败，修复复验中；尚无整套通过报告 |
| macOS Intel（macos-15-intel） | 40f6245 / 37599631279 | 通过；acceptance-macos-x64 / native-summary.json |
| Windows x64（windows-2022） | 40f6245 / 37599631279 | 安装器模块缺失，修复复验中；尚无整套通过报告 |
| Linux x64（ubuntu-24.04） | 40f6245 / 37599631279 | 通过；acceptance-linux-x64 / native-summary.json |

最终发行能力以 Release 附件中对应同一发行提交的四份 native-summary.json 为准，并保留对应 Actions run 与各平台原始阶段报告。首次两平台通过、本机 Mac 通过或已写好修复，均不能代替最终提交的四平台验收。

Linux ARM64 与 Windows 11 ARM64 不在上述 CI 矩阵中，仍需各自真实机器验收。CI 的 Windows Server runner 通过，也不能单独证明全部 Windows 10/11 桌面环境均已验证。

本机安装和协议夹具不能代替具体 WorkBuddy 客户端、用户中继或远端文件端到端验收。源码隐私与依赖清单检查见 [发布审计](release-audit.md)。

## 本机可自行核验

安装后运行 control.py status，确认服务身份、依赖、配置与系统凭据库。打开网页核对当前配置和实例，再按 [首次连接](first-connection.md) 执行真实通道验收。自动化测试可参考 app 下的测试源码；依赖真实远端/云凭据的测试不能在无授权时运行。

## 问题报告

建议附上：发行版本、操作系统、Node/Python 版本、当前步骤、脱敏错误、失败层、最后真实成功时间与缺失证据。日志、登记表和聊天均可能包含个人信息，上传前审核。不要公开 Token、私钥、密码或可直接访问的短期 URL。
