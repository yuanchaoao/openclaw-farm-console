# 架构与完成证据

## 两条独立通道

~~~text
本机网页 → 本机 Console → Python adapter → 官方 OpenClaw SDK → 远端 Gateway
                                           └ 会话 / 配对 / 控制 / 维护任务

本机文件操作 → 本机回环端口 → SSH -L → 中继回环端口
                                           → SSH -R → 远端回环文件桥 → 工作区
~~~

Gateway 可用不证明文件桥可用，文件桥可用也不证明模型推理可用。本仓库没有把真实模型调用作为健康检查；实际模型调用可能消耗用户自己的服务额度。

Console 默认只绑定本机回环，负责登记、排队、批准界面和持久任务。每个远端文件桥也只绑定回环；中继与本地端口均按实例独占。中继是一台用户自行管理的 Linux OpenSSH 服务器，可来自任何云供应商、机房或自有主机；仓库没有云供应商 API 依赖。

## 目录

| 路径 | 内容 |
|---|---|
| control.py | 公共安装、启动、诊断、MCP 与卸载入口 |
| app/console | Console 服务与网页 |
| app/openclaw-farm/scripts | CLI、MCP 服务、官方 SDK 调用、文件桥与传输 |
| app/openclaw-farm/SKILL.md | 可选智能体操作 skill |
| runtime/node/package-lock.json | 锁定 OpenClaw 与 npm 依赖 |
| scripts/requirements-lock.txt | Python 依赖版本 |
| docs、examples | 教程、API、许可与脱敏示例 |
| 安装后 config、data、logs、backups | 当前用户创建的配置、业务状态、日志和备份；不进入发布包 |

## 完成条件

登记凭据成功是本地结果。配对必须由远端批准并通过同一身份的认证调用。远端维护的 ACK、runId、日志中的 READY、PID 或监听端口只是线索。最终文件桥连接必须有真实能力响应和唯一测试文件的写入、读回、删除证据，并持久保存结果。

一次操作报告应记录：实例 ID 与显示名、授权范围、开始/结束时间、原请求编号、每层真实检查、首个断点、最小变更、文件哈希或测试结果、仍缺失证据和继续入口。报告不得保存 Token、密码或私钥。

实例移出列表是归档管理范围，不等同于远端卸载。不同实例的凭据、设备身份、任务或端口不得互相复用。
