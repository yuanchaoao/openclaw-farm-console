import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const BUNDLED_BRIDGE = new URL("../openclaw-farm/scripts/file_bridge_server.py", import.meta.url);
export const EXPECTED_SHA256 = "4a20282d5ff266353ec703964d34db0d21805a9a85835f56dab6ea6d5145a353";
export const DEFAULT_BRIDGE_URL = "";
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// Both setup paths share this configured source and pinned hash. Bundled delivery
// remains an explicit fallback when selected in local configuration.
export async function bridgeProgramInstall(variable, sourcePath = BUNDLED_BRIDGE, options = {}) {
  if (!["D", "BRIDGE_DIR"].includes(variable)) throw new Error("文件桥安装目录变量无效");
  const mode = options.mode || process.env.OPENCLAW_FILE_BRIDGE_INSTALL_MODE || "bundled";
  if (!["r2", "bundled"].includes(mode)) throw new Error("文件桥安装来源无效");
  const configuredHash = process.env.OPENCLAW_FILE_BRIDGE_R2_SHA256;
  if (configuredHash && configuredHash !== EXPECTED_SHA256) throw new Error("文件桥校验配置与已批准版本不一致");
  const target = `"$${variable}/server.py.new"`;
  const finalSteps = [
    `[ "$(sha256sum ${target} | awk '{print $1}')" = "${EXPECTED_SHA256}" ] || { echo '文件桥程序校验失败' >&2; exit 1; }`,
    `chmod 600 ${target} || exit 1`,
    `mv ${target} "$${variable}/server.py" || exit 1`
  ];
  const reuse = lines => [
    `if [ -f "$${variable}/server.py" ] && [ ! -L "$${variable}/server.py" ] && [ "$(sha256sum "$${variable}/server.py" | awk '{print $1}')" = "${EXPECTED_SHA256}" ]; then`,
    ': # Existing verified program is reused without downloading',
    'else',...lines,'fi'
  ];
  if (mode === "r2") {
    const value = options.url || process.env.OPENCLAW_FILE_BRIDGE_R2_URL;
    if (!value) throw new Error("请配置自己的 HTTPS 文件桥下载地址，或使用随包程序");
    let url;
    try { url = new URL(value); } catch { throw new Error("文件桥下载地址无效"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("文件桥下载地址必须使用 HTTPS 且不包含登录凭据");
    return reuse([
      "umask 077",
      // Encode the URL so the remote agent cannot silently alter percent-encoded
      // Chinese path bytes while copying the command into its exec call.
      `BRIDGE_URL=$(printf '%s' ${shellQuote(Buffer.from(url.href).toString('base64'))} | base64 -d)`,
      `curl --fail --location --retry 3 --connect-timeout 15 --max-time 90 --proto '=https' --proto-redir '=https' --url "$BRIDGE_URL" --output ${target} || { echo '文件桥程序下载失败，已保留现有程序' >&2; exit 1; }`,
      ...finalSteps
    ]);
  }
  const bytes = await readFile(sourcePath);
  if (createHash("sha256").update(bytes).digest("hex") !== EXPECTED_SHA256) {
    throw new Error("包内文件桥程序校验失败，已停止生成安装命令。");
  }
  const source = bytes.toString("utf8");
  const delimiter = `OPENCLAW_BRIDGE_SOURCE_${EXPECTED_SHA256}`;
  if (!source.endsWith("\n") || source.split("\n").includes(delimiter)) throw new Error("文件桥源码封装失败");
  return reuse([
    "umask 077",
    `cat > ${target} <<'${delimiter}'\n${source}${delimiter}`,
    ...finalSteps
  ]);
}
