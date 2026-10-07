# 通用 Linux OpenSSH 中继

中继可部署在任何可由本机和远端实例通过 SSH 访问的 Linux 主机上。需要 OpenSSH Server、Python 3、当前用户的 .ssh/authorized_keys 管理权限；修改 sshd 配置需要服务器管理员权限。没有 Oracle SDK、OCI API、云 API 或指定供应商要求。

## 路径与端口

~~~text
本机 127.0.0.1:20080
    -- SSH -L --> 中继 localhost:20080
    <-- SSH -R -- 远端实例 127.0.0.1:18081 文件桥
~~~

20080 是文档示例，实际端口由登记表与配置范围分配。每实例一个中继回环端口和一个本地回环端口，不得复用其他实例的端口。SSH 服务端口 22 与转发端口不是同一概念。

服务端设置 GatewayPorts no，不对公网开放转发端口。防火墙仅需允许已选择的 SSH 服务访问；不要开放 19900–20080 作为公共 HTTP 服务。远端桥绑定回环并使用范围 Token 鉴权。

## 准备服务端

先使用自己现有的管理员/SSH 入口把 relay/prepare.sh 与 relay/authorize_key.py 复制到所选服务器。确认目标用户存在，再运行：

~~~sh
sudo sh prepare.sh relayuser
sudo sh prepare.sh relayuser --apply
~~~

第一条只检查，第二条为准确用户写入转发设置并验证 sshd 配置。脚本需要服务器已经 Include sshd_config.d；不满足时会停下并说明手工设置。手工配置应只针对目标用户：

~~~text
Match User relayuser
    AllowTcpForwarding yes
    GatewayPorts no
    PermitListen localhost:*
Match all
~~~

保留一个已登录的管理员会话，先执行 sshd -t，再按该系统服务管理器 reload，核验实际生效配置。脚本按准确用户写入独立 drop-in，并保留之前文件的持久备份；仍需先核对该用户的现有策略，不能覆盖健康用户的限制。

## 授权本机公钥

在 Console 首次配置点击创建专用密钥。已存在密钥不覆盖；页面只返回公钥。核对服务器 SSH host key，然后把生成的授权脚本在所选服务器的准确用户身份下执行。

也可把本机公钥复制为 client.pub，在中继执行：

~~~sh
python3 authorize_key.py --public-key-file client.pub --kind client --port-min 19900 --port-max 20080
~~~

此授权只允许配置范围内的回环 permitopen，保留其他 authorized_keys 行。使用 --authorized-keys 可指定目标文件；目标必须属于准确 SSH 登录用户。切勿复制私钥到中继或仓库。

## 授权每实例公钥

文件桥安装在对应实例创建其自己的隧道 Ed25519 密钥并返回公钥。核对 ID、任务、公钥指纹和保留端口后，仅授权该实例：

~~~sh
python3 authorize_key.py --public-key-file instance.pub --kind instance --port 20080 --port-min 19900 --port-max 20080
~~~

授权行 restrict,port-forwarding,permitlisten="localhost:20080" 只准该回环监听。客户端授权和实例反向监听授权是两件事。脚本修改前保留 authorized_keys 备份，并按完整公钥识别自己的行；恢复时只更正证明损坏的那一行。

## 正确转发方向

在远端实例使用其专用隧道私钥：

~~~sh
ssh -p 22 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i /PRIVATE/INSTANCE/KEY -R localhost:20080:127.0.0.1:18081 relayuser@relay.example.invalid
~~~

本机使用管理台专用私钥：

~~~sh
ssh -p 22 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i /PRIVATE/CLIENT/KEY -L 127.0.0.1:20080:localhost:20080 relayuser@relay.example.invalid
~~~

程序一般生成/管理转发，不需手工同时启动第二条。SSH host key 首次建立时请通过可信渠道核对；不要把 StrictHostKeyChecking=no 或删除 known_hosts 当通用修复。

## 核验与恢复

配置页“检查中继”验证实际 SSH 与服务器 Python。随后必须通过已鉴权 /v1/capabilities 验证中继端口，再验证本机端口，最终做唯一文件验收。单独 SSH 返回 0、端口监听、TUNNEL_READY 或 PID 都不算文件桥接通。

迁移中继时，更新用户配置不会让旧本地 SSH 连接自动更换目的地。核对实际转发目标，只处理该实例归属明确的旧连接，再验证新路径。见 [恢复工作流](recovery.md)。任何文件桥 Token 只能通过保护的请求/凭据库传递，不写进诊断命令、截图或公开记录。
