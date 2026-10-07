from __future__ import annotations

import asyncio
import unittest

import openclaw_mcp_server as server


ORIGINAL_TOOLS = {
    "openclaw_list_instances",
    "openclaw_run_bash",
    "openclaw_exec_approve",
    "openclaw_sessions_list",
    "openclaw_chat_send",
    "openclaw_chat_history",
    "openclaw_read_file",
    "openclaw_file_list",
    "openclaw_file_stat",
    "openclaw_file_read",
    "openclaw_file_write",
    "openclaw_file_upload",
    "openclaw_file_download",
    "openclaw_file_move",
    "openclaw_file_copy",
    "openclaw_file_delete",
    "openclaw_file_mkdir",
}


class McpCompatibilityTests(unittest.TestCase):
    def test_exact_original_tool_set(self) -> None:
        tools = asyncio.run(server.mcp.list_tools())
        self.assertEqual({tool.name for tool in tools}, ORIGINAL_TOOLS)

    def test_mutations_stop_before_registry_access_without_approval(self) -> None:
        guarded_results = (
            server.openclaw_run_bash("true"),
            server.openclaw_file_write("a.txt", "content"),
            server.openclaw_file_upload("local", "remote"),
            server.openclaw_file_move("a", "b"),
            server.openclaw_file_copy("a", "b"),
            server.openclaw_file_delete("a"),
            server.openclaw_file_mkdir("a"),
        )
        for result in guarded_results:
            self.assertIn("approved=true", result)

        self.assertIn(
            "approved=true",
            server.openclaw_file_download("remote", "local", overwrite=True),
        )


if __name__ == "__main__":
    unittest.main()
