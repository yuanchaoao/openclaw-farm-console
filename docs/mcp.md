# MCP 客户端接入

MCP 服务采用 stdio，提供 [17 个工具](mcp-tools.md)。MCP 客户端启动公共 control.py mcp 入口；它读取安装后的本用户配置、登记表和系统凭据库。CLI 和 MCP 共用同一份实例状态。

## 通用 stdio 配置

先安装并通过 control.py status 核对安装位置。在自己的 MCP 客户端配置中填入绝对路径：

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

Windows 示例见 [examples/mcp-windows.json](../examples/mcp-windows.json)，POSIX 示例见 [examples/mcp-stdio.json](../examples/mcp-stdio.json)。使用安装器创建的私有 Python 绝对路径，不要求客户端 PATH 中存在 Python。不要把 Token 或凭据环境变量加入此 JSON。

WorkBuddy：在客户端的 MCP/工具服务设置中新增 stdio 服务，填写服务名 openclaw-farm，以及示例的 command、args。若客户端支持导入 mcpServers JSON，直接导入示例并替换路径；不同版本 UI 字段可能不同，仓库示例只保证标准 stdio 启动命令，不声称某个客户端版本已经实机验通。其他支持 stdio 的客户端采用同一路径。

## 第一次工具调用

1. 运行 openclaw_list_instances，确认只返回自己的登记实例。
2. 始终显式传入 instance。多实例且无唯一默认值时，省略 instance 会报错。
3. Gateway 已验通后，运行 openclaw_sessions_list。文件桥已验通后，运行 openclaw_file_list。
4. 写入、远端命令、任务发送与执行批准的 approved 参数，只能表达已经取得的用户授权。参数为 true 本身不是授权来源。
5. 要验证写入，事先授权一个唯一临时文件、写入内容、读回与清理，再执行整套验收。具体步骤见 [文件操作](files.md)。

## 授权边界

Console 默认保护命名实例，并允许当前任务明确授权的单实例调用。MCP/底层 CLI 按传入实例执行，不会替使用者判断数字/命名批量政策；调用者必须按 [批量规则](batch.md) 选择目标。远端配对、远端执行 allow-once、文件写入和删除是不同授权，不能相互代替。

任务重试复用同一个 idempotency_key。发送 ACK 不等于完成；通过会话历史、输出文件或目标服务实际结果核验。已经运行的任务不要随意 sessions.steer，后者可能中断其当前工具调用。

## 故障

- 无实例：检查当前安装用户及 data/instances.json。
- 凭据库不可用：解锁本系统凭据库；Linux 检查当前用户 D-Bus/Secret Service 会话。系统不会退回明文文件。
- 配对等待：核对同一设备的完整请求，不重复生成新身份。
- stdio 无工具：检查客户端使用的 Python 路径与安装路径，手动运行 control.py mcp 检查启动错误；服务会保持读取 stdin，这是正常状态。
- CLI 有效而 MCP 陈旧：确认客户端载入的是当前安装，重启该客户端的 MCP 进程一次，保留原凭据与设备身份。
