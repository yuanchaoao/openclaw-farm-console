# macOS 使用与迁移

公开版使用根install.command、scripts/install/install.sh或control.py install。安装器获取独立锁定依赖，使用登录钥匙串，不依赖某个聊天软件包内的运行时。

默认本用户安装目录为 ~/Library/Application Support/OpenClaw Farm Console。所有生命周期动作使用根control.py。迁移前备份自己的config/data与受保护设备身份，凭据按原生系统方式迁移，不能纳入公开包。

迁移后逐层核对Gateway、远端桥、中继-R、本机-L与唯一文件读写删除。监听端口不证明实际转发目标；只修确证损坏的层。见 [安装](../docs/installation.md)、[恢复](../docs/recovery.md)、[验证范围](../docs/validation.md)。
