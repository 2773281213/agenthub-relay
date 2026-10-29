# Connecting a planner / 接入规划者

Any agent that can load an MCP server can plan. The relay serves eight `relay_*` tools over stdio:

```
node /absolute/path/to/agenthub-relay/src/cli.mjs mcp
```

The server works on one git repository, found in this order: `AGENTHUB_RELAY_ROOT`, `CLAUDE_PROJECT_DIR`, the directory the client starts it in. MCP clients normally start servers in the project directory, so no setting is needed.

Only Claude Code gets the keep-alive mod. Other planners wait with `relay_wait`, which always returns within 50 seconds so that it stays under each client's tool timeout.

任何能加载 MCP 服务的 agent 都可以当规划者；只有 Claude Code 带保活 mod，其他规划者用 `relay_wait` 等待（每次 50 秒内返回）。

## Claude Code

Install the plugin. It brings the MCP server, the mod (keep-alive, wake-up, `/relay`, status line) and the routing skill. At the prompt of a terminal session:

```
/plugin install agenthub-relay --marketplace 2773281213/agenthub-relay
```

From a shell: `claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `2773281213/agenthub-relay`, then Add plugin.

Mods load in Claude Code 2.1.287 and later. The plugin's options (`keep_alive`, `interval_minutes`, `ceiling_hours`, `wake_on_finish`) appear in `/config`.

The tools alone, without the mod: `claude mcp add agenthub-relay -- node /absolute/path/to/agenthub-relay/src/cli.mjs mcp`.

## Codex

```
codex mcp add agenthub-relay -- node /absolute/path/to/agenthub-relay/src/cli.mjs mcp
```

or in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.agenthub-relay]
command = "node"
args = ["/absolute/path/to/agenthub-relay/src/cli.mjs", "mcp"]
```

Codex's default `tool_timeout_sec` is 60, which `relay_wait` respects. For the routing skill, install `skills/agenthub-relay` where your Codex setup reads skills; the third-party skills CLI does this: `npx skills add 2773281213/agenthub-relay --skill agenthub-relay`.

To let Claude Code take deep work while Codex plans, set `"profile": "codex-planner"` in `.agenthub/config.json` or `AGENTHUB_RELAY_PROFILE=codex-planner`.

## DeepSeek Harness (`dsh`)

DeepSeek Harness ships an MCP client with no server enabled by default; it treats each server command as trusted code that runs outside its sandbox. Its public documentation that we checked does not show the configuration file, so add a stdio server named `agenthub-relay` with command `node` and arguments `/absolute/path/to/agenthub-relay/src/cli.mjs mcp` through dsh's own MCP settings.

Skills: copy `skills/agenthub-relay` into `~/.dsh/skills/` or the project's `.dsh/skills/`.

## Antigravity (`agy`)

Antigravity reads MCP servers from `~/.gemini/config/mcp_config.json` (all projects) or `<workspace>/.agents/mcp_config.json` (one workspace):

```json
{
  "mcpServers": {
    "agenthub-relay": {
      "command": "node",
      "args": ["/absolute/path/to/agenthub-relay/src/cli.mjs", "mcp"]
    }
  }
}
```

Antigravity can plan in v0.1. As an executor it is reserved: dispatching to `agy` fails with a reason until the v0.2 adapter.

## Sources

- [Codex: Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli)
- [Antigravity: MCP](https://antigravity.google/docs/mcp)
- [Claude Code: plugin manifest reference](https://code.claude.com/docs/en/plugins-reference.md)
- [DeepSeek Harness overview (eesel)](https://www.eesel.ai/blog/deepseek-harness)
