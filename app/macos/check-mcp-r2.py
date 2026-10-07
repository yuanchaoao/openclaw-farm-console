"""Read-only live check; report no credentials, session contents or URLs."""
import asyncio
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

installed = Path.home() / "Library/Application Support/OpenClaw Farm Console"
config = json.loads((installed / "config/local.json").read_text())
env = os.environ.copy()
env.update(config["environment"])
script = Path(__file__).resolve().parents[1] / "openclaw-farm/scripts/openclaw_mcp_server.py"


async def main():
    parameters = StdioServerParameters(command=str(installed / "runtime/python/bin/python"), args=[str(script)], env=env)
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            names = {tool.name for tool in (await client.list_tools()).tools}
            assert len(names) == 16
            assert {"openclaw_sessions_list", "openclaw_chat_history", "openclaw_chat_send"} <= names
            result = await client.call_tool("openclaw_sessions_list", {"instance": "ins_uqrs15srj", "limit": 5})
            content = "\n".join(item.text for item in result.content if item.type == "text")
            try:
                payload = json.loads(content)
                sessions = payload.get("sessions")
                assert isinstance(sessions, list)
            except (ValueError, AssertionError):
                print(json.dumps({"mcp_tools": len(names), "sessions_list": "failed", "details": "omitted"}))
                return 1
            history = "not_checked_no_session"
            if sessions and isinstance(sessions[0].get("key"), str):
                result = await client.call_tool("openclaw_chat_history", {
                    "instance": "ins_uqrs15srj", "session_key": sessions[0]["key"], "limit": 1})
                try:
                    payload = json.loads("\n".join(item.text for item in result.content if item.type == "text"))
                    history = "passed" if isinstance(payload.get("messages"), list) else "failed"
                except ValueError:
                    history = "failed"
            print(json.dumps({"mcp_tools":len(names),"sessions_list":"passed", "visible_sessions":len(sessions),
                              "chat_history":history,"remote_writes":0,"r2_download":"awaiting_test_file"}))
            return int(history == "failed")


sys.exit(asyncio.run(main()))
