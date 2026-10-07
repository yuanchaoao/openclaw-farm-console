# 文件 CRUD 与分块续传

以下 CLI 在安装目录使用私有 Python，通过 control.py farm 加载本用户配置并转发到 adapter。Windows 将 ./runtime/python/bin/python 替换为 .\runtime\python\Scripts\python.exe。命令中的 ins_demo01 是虚构示例，替换为自己的实例。MCP 用户使用同名能力，见 [工具参考](mcp-tools.md)。

所有远端路径相对于已登记工作区，例 reports/note.txt。先创建父目录；不要传本机绝对路径作为远端路径。只有本地上传/下载路径使用绝对路径。

## 读取

~~~sh
./runtime/python/bin/python control.py farm file-list ins_demo01 .
./runtime/python/bin/python control.py farm file-stat ins_demo01 reports/note.txt
./runtime/python/bin/python control.py farm file-read ins_demo01 reports/note.txt --max-bytes 1048576
~~~

大文件或二进制文件使用 download，不放入聊天文本或 file-read。

## 创建、覆盖与移动

先确认本次目录、内容和操作已经授权：

~~~sh
./runtime/python/bin/python control.py farm file-mkdir ins_demo01 reports --approved-write
./runtime/python/bin/python control.py farm file-write ins_demo01 reports/note.txt --content-file /ABSOLUTE/PATH/note.txt --approved-write
~~~

覆盖前运行 file-stat，保留实际 SHA-256：

~~~sh
./runtime/python/bin/python control.py farm file-write ins_demo01 reports/note.txt --content-file /ABSOLUTE/PATH/note.txt --expected-sha256 ACTUAL_CURRENT_SHA256 --approved-write
./runtime/python/bin/python control.py farm file-copy ins_demo01 reports/note.txt reports/note-copy.txt --approved-write
./runtime/python/bin/python control.py farm file-move ins_demo01 reports/note-copy.txt reports/archive.txt --approved-write
~~~

目标已存在、版本已变化或哈希不匹配时会失败。先重新核对内容和授权，不能删除目标再强行绕过冲突。

## 上传和下载

~~~sh
./runtime/python/bin/python control.py farm file-upload ins_demo01 /ABSOLUTE/PATH/archive.zip uploads/archive.zip --chunk-size 8388608 --approved-write
./runtime/python/bin/python control.py farm file-download ins_demo01 uploads/archive.zip /ABSOLUTE/PATH/downloaded.zip
~~~

上传默认 8 MiB 分块，服务默认单块上限 16 MiB，文件上限 64 GiB；这些是默认限制，不是吞吐保证。相同源文件、实例和目标再次执行会尝试续传；服务返回实际偏移后继续。修改了源文件就属于新内容，不能拼接旧上传。

覆盖远端文件还需 --overwrite、--expected-remote-sha256 ACTUAL_CURRENT_SHA256 与 --approved-write。覆盖本地文件需 --overwrite --approved-write。只有确认要舍弃已有续传记录时才用 --no-resume。

下载保留部分文件，按 Range 续传。上传 commit 和下载完成都验证大小与 SHA-256，失败不能宣称交付成功。向第三方分享或上传对象存储属于额外授权；Boto3 工具是可选渠道，不是文件桥恢复的替代品。

## 删除

~~~sh
./runtime/python/bin/python control.py farm file-delete ins_demo01 reports/archive.txt --expected-sha256 ACTUAL_CURRENT_SHA256 --approved-delete
~~~

目录还需 --recursive。服务必须启用 delete，并有匹配 delete scope。工作区根目录不可删除。备份是恢复辅助手段，不意味着可以省略目标与授权核对。

## 唯一文件验收

为每次测试生成唯一名称，例如 console-check-UUID.txt。授权创建、读回和清理后，写入一段已知文本、取 stat 哈希、读回比较、按该哈希删除，再确认 not_found。报告保存路径、哈希与结果，不保存 Token。若没有删除授权，将测试记为“读写通过、清理待授权”，不要写成完整验收通过。

## 对象存储与同步

大批文件可在获得明确授权后使用自有 S3 兼容对象存储。fast_object_transfer.py 使用受保护的配置、multipart 与校验；短期 URL 必须按需保密，任务后验证清理。没有通用“所有文件都同步”授权。同步前列明源、目的地、冲突策略、删除范围和验证方法；读取远端真实结果后才记账完成。
