import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { bridgeProgramInstall } from "../console/bridge-installer.mjs";
import {runShell,shellPath} from './portable-test-tools.mjs';

test("R2 command preserves URL quoting and preserves the old program on download or checksum failure", async () => {
  // A local curl stand-in tests generated commands without accessing any URL.
  const directory = await mkdtemp(join(tmpdir(), "bridge download test "));
  const sourcePath = new URL("../openclaw-farm/scripts/file_bridge_server.py", import.meta.url);
  try {
    await writeFile(join(directory,"curl"), [
      "#!/bin/sh",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --url) printf "%s" "$2" > "$URL_RECORD"; shift 2 ;;',
      '    --output) dest="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      '[ "$DOWNLOAD_FAIL" = 1 ] && exit 22',
      'cp "$DOWNLOAD_FIXTURE" "$dest"',
      ''
    ].join("\n"), {mode:0o700});
    const fixture = join(directory,"download-fixture");
    const record = join(directory,"url-record");
    const env = {...process.env, PATH:`${directory}${delimiter}${process.env.PATH}`, DOWNLOAD_FIXTURE:shellPath(fixture), URL_RECORD:shellPath(record), DOWNLOAD_FAIL:"0"};
    const url = "https://assets.example.test/file_bridge_server.py" + "?note=it's%20encoded";
    const lines = await bridgeProgramInstall("D", undefined, {mode:"r2",url});
    const run = () => runShell(`D="$1"\n${lines.join("\n")}\n`,[directory],{env,stdio:"pipe"});
    await writeFile(fixture, await readFile(sourcePath));
    run();
    assert.equal(await readFile(record,"utf8"), new URL(url).href);
    assert.deepEqual(await readFile(join(directory,"server.py")),await readFile(sourcePath));
    await writeFile(join(directory,"server.py"),"existing program");
    await writeFile(fixture,"corrupt download");
    assert.throws(run);
    assert.equal(await readFile(join(directory,"server.py"),"utf8"),"existing program");
    env.DOWNLOAD_FAIL="1";
    assert.throws(run);
    assert.equal(await readFile(join(directory,"server.py"),"utf8"),"existing program");
    await assert.rejects(bridgeProgramInstall("D",undefined,{mode:"r2",url:"http://example.test/file.py"}),/HTTPS/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("offline installer delivers exact program bytes to a path containing spaces", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bridge installer test "));
  try {
    for (const variable of ["D", "BRIDGE_DIR"]) {
      const lines = await bridgeProgramInstall(variable, undefined, { mode:"bundled" });
      runShell(`set -eu\n${variable}="$1"\n${lines.join("\n")}\n`,[directory]);
      assert.deepEqual(await readFile(join(directory,"server.py")), await readFile(new URL("../openclaw-farm/scripts/file_bridge_server.py", import.meta.url)));
      assert.ok(lines.some(line=>line===`chmod 600 "$${variable}/server.py.new" || exit 1`));
      await t.test(`${variable} owner-only Linux program permissions`,{skip:process.platform==='win32'?'POSIX file modes are enforced on the Linux relay':false},async()=>assert.equal((await stat(join(directory,"server.py"))).mode & 0o777, 0o600));
    }
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test("altered source and an unexpected shell variable are rejected before delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge invalid "));
  try {
    const path = join(directory, "server.py");
    await writeFile(path, "not the approved file\n");
    await assert.rejects(bridgeProgramInstall("D", path, { mode:"bundled" }), /校验失败/);
    await assert.rejects(bridgeProgramInstall("UNKNOWN"), /目录变量无效/);
  } finally { await rm(directory, { recursive:true, force:true }); }
});
