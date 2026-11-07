# Connecting a planner / 接入规划者

Any agent that can run a shell command and Node.js 20 can plan: install the `agenthub-relay` skill and it carries the relay with it. MCP is optional; it is what the Claude Code plugin uses, and any MCP client can use it too.

任何能运行 shell 命令和 Node.js 20 的 agent 都可以当规划者：装上 `agenthub-relay` skill 就带上了 relay，不必配置 MCP。MCP 是可选入口，Claude Code 插件用它，其他 MCP 客户端也可以用。

## 1. Install the skill

```
npx skills add 2773281213/agenthub-relay --skill agenthub-relay
```

or copy the whole `skills/agenthub-relay` folder (with its `scripts/`) to where your planner reads skills. Install one copy only: a planner that reads two of these folders would see two skills with the same name.

The skill's `description` says what it does and when to use it, so every host can read it. Its `when_to_use` adds example requests in English and Chinese ("let Codex do this", "交给 codex 做"); Claude Code appends it to the description, and hosts that do not know the field are expected to ignore it. Uploads to claude.ai and the Skills API accept only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`, so remove `when_to_use` (and `disable-model-invocation` from the thin entries) before uploading there.

| Planner | User skills | Project skills |
|---|---|---|
| Claude Code | `~/.claude/skills` (or the plugin, below) | `.claude/skills` |
| Codex | `~/.agents/skills` | `.agents/skills` |
| DeepSeek Harness | `~/.dsh/skills` or `~/.agents/skills` | `.dsh/skills` or `.agents/skills` |
| Antigravity | `~/.agents/skills` (the CLI: `~/.gemini/antigravity-cli/skills`) | `.agents/skills` |

The explicit-only entries `relay-review`, `relay-status` and `relay-config` live next to it in `skills/`; copy them into the same folder so that their `../agenthub-relay/scripts/cli.mjs` resolves.

The planner then runs, from the repository it works in:

```
node <skill folder>/scripts/cli.mjs <command> --planner <claude|codex|dsh|agy>
```

`--planner` (or `AGENTHUB_RELAY_PLANNER`) says who is planning. It selects the profile for that planner and is recorded with each job. Without it the planner is `unknown` and gets the default profile.

The repository is found in this order: `AGENTHUB_RELAY_ROOT`, `CLAUDE_PROJECT_DIR`, the working directory.

## 2. Start each planner session

Dispatch works only inside a planner session the user confirmed. At the start of every planner session:

```
session start --planner codex
session confirm <sessionId> --reuse                                   # keep the saved roles
session confirm <sessionId> --deep claude:opus@high --review codex:gpt-5.1-codex@medium [--user]   # or change them
dispatch --session <sessionId> --tier deep ...                        # or export AGENTHUB_RELAY_SESSION
```

`session start` lists the saved roles (for each tier the executor, model and effort, and where each comes from), who planned last, each agent's own default model, the models each agent offers and a check of each; the planner shows this to the user and confirms with their answer. Changes are checked first and saved for later sessions; when a check fails nothing is saved. Another agent cannot confirm or dispatch in the session (`planner-mismatch`); without a confirmed session dispatch returns `session-required`. MCP clients use `relay_session` (`action: start | confirm | show`) and the connection keeps its session. For scripts, `config set sessions.required false` turns the requirement off.

## 3. Choose executors and models

`config show` lists the active profile and why it was chosen, and for each tier the executor, model and effort. `models [codex|claude|dsh]` lists what each agent offers and uses by default:

- Codex: the models of the signed-in account from `codex app-server` (`model/list`), with the reasoning efforts each supports. A codex model and effort must be in that list; when the list cannot be read, a codex model cannot be checked and is refused (leave the model out to use codex's own default). Its default comes from `.codex/config.toml` in the repository, then `$CODEX_HOME/config.toml`.
- Claude Code: its documented aliases (`opus`, `sonnet`, `haiku`, `opus[1m]`, …), plus the API's list when `ANTHROPIC_API_KEY` is set. Names are checked by form only; effort must be one of low, medium, high, xhigh, max. Its default comes from `ANTHROPIC_MODEL`, then `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`.
- DeepSeek Harness: uses its own settings (`agent-default-model` in `$DSH_HOME/settings.yaml`); the relay shows that model and gives it none.

The relay reads these settings files and never writes them. `models check <agent> <model> [--effort e]` checks one name.

- Built in, a Claude Code planner gets `thread16` (deep → codex, light → dsh, review → claude) and a Codex planner gets `codex-planner` (deep → claude, light → dsh, review → codex). Any profile named in a configuration file takes precedence over these built-in planner defaults; `plannerProfiles` sets one per planner.
- One job: `dispatch --executor claude --model opus --effort high`, checked like a saved choice. The relay passes them through each CLI's own flags: Codex `-m <model>` and `-c model_reasoning_effort=<effort>`, Claude Code `--model` and `--effort`. DeepSeek Harness documents no per-run model flag (its model is set in its `settings.yaml`), so the relay refuses a model for it with `model-unsupported`; if your dsh build has such a flag, set `executors.dsh.modelArgs`, for example `["--model", "{model}"]`.
- Lasting choices outside a session (also checked before they are written):

```
config set profiles.thread16.deep claude:opus@high     # a tier: executor[:model][@effort]
config set executors.codex.model gpt-5.1-codex         # an executor's default model
config set plannerProfiles.codex thread16              # which profile a Codex planner gets
config set profile codex-planner                       # the default profile
config unset profiles.thread16.deep
```

Without `--user` these go to the repository's `.agenthub/config.json`; with `--user` to `~/.config/agenthub-relay/config.json` (or `$XDG_CONFIG_HOME/agenthub-relay/config.json`, or `AGENTHUB_RELAY_USER_CONFIG`), which applies to every project. The project file overrides the user file. Credentials (`passEnv`, variable names only) are edited by hand. An executor (`AGENTHUB_RELAY_ROLE=executor`) can change nothing.

The planner's own model is set in the planner's host; the relay only reads it.

## Windows

The relay runs on Windows as well. `doctor` shows how each executor starts: `direct` for an `.exe`, `shim-node` when an npm or pnpm `.cmd` shim is resolved to node plus the script it wraps (so a multi-line task reaches the program verbatim, never through cmd.exe), `shim-exe` when a shim wraps an `.exe`. A shim it cannot read is reported as unusable; set `executors.<id>.command` to the `.exe` or `.js` file instead. Checks run in cmd.exe by default; `config set checks.shell "C:\Program Files\Git\bin\bash.exe"` runs them in Git Bash. Cancels and timeouts end the executor's whole process tree with `taskkill /T /F`.

Windows 上同样可用：`doctor` 会显示每个执行者的启动方式；npm、pnpm 的 `.cmd` 外壳被解析为“node + 脚本”直接启动；检查默认走 cmd.exe，可用 `checks.shell` 改成 Git Bash；取消与超时用 taskkill 结束整棵进程树。

## 4. Waiting

From the command line, `wait` returns when a job ends or after `--timeout` seconds (50 by default, at most 3600; keep it under your shell tool's own timeout). Only Claude Code has the keep-alive mod; other planners poll with `wait`.

## Claude Code

Install the plugin. It brings the four skills, the MCP server, the mod (keep-alive, wake-up, `/relay`, status line). At the prompt of a terminal session:

```
/plugin install agenthub-relay --marketplace 2773281213/agenthub-relay
```

From a shell: `claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `2773281213/agenthub-relay`, then Add plugin.

Mods load in Claude Code 2.1.287 and later. The plugin's options (`keep_alive`, `interval_minutes`, `ceiling_hours`, `wake_on_finish`) appear in `/config`. With the plugin, Claude Code is recognized as the planner from its MCP client name; jobs it dispatches through the script are kept warm and woken for too, because the mod reads the same job store.

## Optional: MCP for other planners

The relay serves ten `relay_*` tools over stdio: `node /absolute/path/to/agenthub-relay/src/cli.mjs mcp` (or the skill's `scripts/cli.mjs mcp`). `relay_wait` returns within 50 seconds so that it stays under each client's tool timeout. The planner is recognized from the client name (`codex-mcp-client` → codex); set `AGENTHUB_RELAY_PLANNER` in the server's environment if yours is not.

- Codex: `codex mcp add agenthub-relay -- node /absolute/path/to/agenthub-relay/src/cli.mjs mcp`, or `[mcp_servers.agenthub-relay]` with `command = "node"` and `args = [".../src/cli.mjs", "mcp"]` in `~/.codex/config.toml`. Codex's default `tool_timeout_sec` is 60.
- DeepSeek Harness: its public documentation that we checked does not show the MCP configuration file; add a stdio server named `agenthub-relay` with command `node` and arguments `/absolute/path/to/agenthub-relay/src/cli.mjs mcp` through dsh's own MCP settings. The skill route above needs none of this.
- Antigravity: `~/.gemini/config/mcp_config.json` (all projects) or `<workspace>/.agents/mcp_config.json`, under `"mcpServers"`.

Antigravity can plan, and it can execute: the `agy` executor runs the Antigravity CLI headless and takes Gemini models by the slugs `agy models` lists, such as `gemini-4-argon-high`. Install the CLI (`agy`) and sign in once in an interactive `agy` session before dispatching to it. Gemini models are reached only through Antigravity; Gemini CLI is neither an executor nor taken for the Antigravity planner.

## Sources

- [Codex: Agent Skills](https://developers.openai.com/codex/skills)
- [Codex: command line options (`--model`, `-c key=value`)](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex: Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli)
- [Authoring Google Antigravity Skills](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
- [Antigravity: MCP](https://antigravity.google/docs/mcp)
- [DeepSeek Harness with APIYI (models in settings.yaml, headless profile)](https://docs.apiyi.com/en/scenarios/agent/deepseek-harness.md)
- [Claude Code: plugin manifest reference](https://code.claude.com/docs/en/plugins-reference.md)
