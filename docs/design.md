# agenthub-relay 设计（v0.1，拟实现）

状态：v0.1 已实现（2026-10-29）。本文是最初的设计说明，地图第 3 版以它为证据；第 4 版起，地图证据改为源码行号。实现时对设计的调整记录在第 12 节。

## 1. 背景与目标

来源是 linux.do 话题《CC 消耗 Token 太快了，除了开 Pro 有别的办法么？》可见第 16 楼（post #19）的思路：用 paseo、bb、lody、t3、Synara 这类已实现各家 agent 互调的工具，让 Claude Code 当主调度，复杂任务交给 Codex，简单明确的任务交给 DeepSeek V4 Flash，再写一个 mod，让 Claude Code 在等待其他 agent 时每 55 分钟保活缓存。

agenthub-relay 把这个思路做成一个中立的 hub：对上用 MCP 工具接任何规划者，对下用各家官方的无人值守模式驱动执行者。目标是让规划者只花少量 token 做拆分、派发和验收，把实现性的 token 消耗转给更便宜或已付费的执行者。

## 2. 思路核对结论

1. 互调可行：所列工具都提供让一个 agent 启动另一个 agent 的接口（CLI、MCP 或 ACP），但没有一个原生覆盖本项目要接的全部四家，因此 v0.1 自建 hub。
2. DeepSeek 的官方模型名现为 `deepseek-flash`，旧名 `deepseek-v4-flash` 仍被接受并路由到同一模型。
3. 55 分钟保活只在 Claude Code 主会话缓存 TTL 为 1 小时时有效。订阅额度内默认 1 小时；API key、超额计费和云厂商默认 5 分钟，需要设置 `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` 或 `promptCacheTtl`。
4. "mods" 是 Claude Code 2.1.287 起默认开启的功能。保活用 `$.model.fork`：它按主会话上一次请求原样发送并读取缓存前缀，不向对话追加轮次。

## 3. 角色模型

规划者和执行者不固定。任何能加载 MCP 服务的 agent 都可以当规划者：Claude Code、Codex、DeepSeek Harness、Antigravity。执行者由档位映射决定，v0.1 实现 Claude Code、Codex、DeepSeek Harness 三家，Antigravity 只在配置里预留。

档位（tier）描述任务性质，不描述代理：

| 档位 | 含义 | 默认执行者（16 楼档位） | 护栏 |
|---|---|---|---|
| deep | 复杂、多文件、需要推理的实现或排错 | codex | 必须声明范围 |
| light | 简单且明确的机械性任务 | dsh（DeepSeek Harness，`deepseek-flash`） | 必须声明文件范围和至少一条检查命令 |
| review | 只读审查或调研 | claude | 只读，任何改动都记为越界 |

档位到执行者的映射按配置里的 profile 切换，例如以 Codex 为规划者时可把 deep 映射到 claude。

## 4. 模块

| id | 职责 | 计划路径 |
|---|---|---|
| planner-surface | MCP 工具面与 CLI，是所有规划者的唯一入口，不假设规划者身份 | `src/mcp.mjs` `src/tools.mjs` `src/cli.mjs` |
| dispatch-policy | 档位映射、light 档护栏、并发写范围冲突锁、预留代理失败关闭、执行者禁止再派发 | `src/policy.mjs` `src/config.mjs` |
| job-store | 任务记录与状态机、事件日志、原子写、心跳存活检测 | `src/store.mjs` |
| git-isolation | 每个任务一个 git worktree、基线提交、变更清单、越界审计、补丁应用与丢弃 | `src/git.mjs` |
| executor-adapters | 三家执行者的命令构造与输出解析，agy 与 ACP 预留 | `src/executors.mjs` |
| worker-runner | 分离进程中的 worker：超时与取消、运行检查、收尾 | `src/worker.mjs` `src/checks.mjs` |
| claude-planner-mod | Claude Code 规划者专用 mod：保活、任务结束唤醒、`/relay` 命令、状态行 | `hooks/` `types/` `.claude-plugin/` `.mcp.json` |
| relay-skill | 可移植的路由手册（Agent Skills 标准），教规划者拆分、选档、写任务、等待和验收 | `skills/agenthub-relay/SKILL.md` |

外部模块：planner-hosts（任一 MCP 客户端规划者）、executor-clis（codex、claude、dsh；agy 预留）、anthropic-cache（Claude 主会话提示缓存）。

## 5. 关系

- 规划者调用 planner-surface 的 `relay_*` 工具。
- planner-surface 先让 dispatch-policy 校验档位、范围与冲突；dispatch-policy 读取 job-store 中活跃任务的范围声明。
- planner-surface 在 job-store 建记录，经 git-isolation 建 worktree，再以分离进程启动 worker-runner。
- worker-runner 通过 executor-adapters 调用 executor-clis，从 git-isolation 取变更清单做越界审计，把状态迁移、心跳和结果写回 job-store。
- claude-planner-mod 通过 `$.mcp.call` 查询任务状态，用 `$.model.fork` 刷新主会话缓存，任务结束时用 `$.prompt.submit` 唤醒 Claude Code。

## 6. 任务生命周期

状态：`queued` → `running` → `verifying` → `completed` | `failed` | `cancelled`；集成状态另记 `none` | `applied` | `discarded`。

1. 派发：校验护栏后取基线提交（主工作区有未提交改动时用 `git stash create` 的快照提交），在 `.agenthub/worktrees/<job>` 建分支 `agenthub/<job>`。
2. 运行：worker 以 `AGENTHUB_RELAY_ROLE=executor` 启动执行者，每 30 秒写心跳；超时或取消时按进程组终止。
3. 检查：在 worktree 里逐条运行检查命令，退出码 0 为 passed，非 0 为 failed，未运行为 not-run；任何一条失败则任务为 failed，没有检查则报告为未验证。
4. 审计：对比基线列出改动文件，范围外的文件列为越界。
5. 集成：规划者看过 `relay_result` 后调用 `relay_apply`（先 `git apply --check`）或 `relay_discard`。

## 7. MCP 工具

| 工具 | 作用 |
|---|---|
| `relay_agents` | 列出执行者、可用性、当前 profile 的档位映射和预留项 |
| `relay_dispatch` | 按档位或指定执行者派发任务，返回任务 id、worktree 与基线提交 |
| `relay_status` | 查询一个或全部任务的状态 |
| `relay_wait` | 最多等待 50 秒，任一任务结束即返回，供没有 mod 的规划者使用 |
| `relay_result` | 摘要、改动文件、越界文件、检查结果和日志路径 |
| `relay_apply` | 把任务补丁应用到主工作区 |
| `relay_discard` | 删除任务 worktree 与分支 |
| `relay_cancel` | 终止运行中的任务 |

## 8. 执行者适配

| 执行者 | 调用方式 | 输出 |
|---|---|---|
| codex | `codex exec --json --sandbox workspace-write -o <最终消息文件> -`，任务从 stdin 传入 | JSONL 事件，最终消息写入文件 |
| claude | `claude -p --output-format json --permission-mode acceptEdits --permission-prompts none`，检查命令加入 `--allowedTools` | JSON 中的 `result` 与用量 |
| dsh | `dsh --profile headless "<任务>"` | stdout 为最后一条回答，完成退出码 0，否则 1 |
| agy | 预留，派发时报错 | — |

执行者只继承 PATH、HOME、语言设置和配置里列出的变量名；密钥值不进入任何记录。

## 9. Claude Code 保活 mod

- 计时起点是主会话最后一次模型请求的开始时间，因为缓存寿命从读写缓存的请求开始算。
- 条件：保活开启、有任务在运行、主会话空闲、距上次请求或上次 fork 达到间隔（默认 55 分钟），且距今仍在 60 分钟内（缓存仍热）；超过上限（默认距最后一次真实请求 8 小时）停止。
- 动作：`$.model.fork` 发一个只要求回复 OK 的问题；记录 `cache_read_input_tokens`。读到 0 且写入很大说明缓存已过期（多半是 5 分钟 TTL），此时暂停保活并提示设置 1 小时 TTL。
- 唤醒：任务进入终态时用 `$.prompt.submit` 发一条提示，引导规划者调用 `relay_result`。
- 空闲压缩：Claude Code 在 1 小时 TTL 下可能于缓存到期前自动压缩空闲会话；mod 记录这类压缩事件，便于判断 fork 是否重置了该计时。

经济性：1 小时缓存写入是基础输入价的 2 倍，读取是 0.1 倍（Opus 5.5 与 Sonnet 5.5 为 0.05 倍），所以在约 18 到 36 小时的等待内保活都比重新写入便宜；默认上限 8 小时。

## 10. 安全与隔离

- 执行者只在自己的 worktree 写；主工作区只经 `relay_apply` 改变。
- 并发写任务的范围按目录前缀判断，重叠即拒绝。
- 执行者环境带 `AGENTHUB_RELAY_ROLE=executor`，此时 hub 拒绝再派发，mod 自停，防止递归。
- 范围声明和越界审计是事后核对，不是文件系统写锁。

## 11. 路线图

- 之后：通用 ACP 执行器（Claude 经 `claude-agent-acp`、Codex 经 `codex-acp`、dsh 原生 `--profile acp`、agy 官方 ACP server），之后可把 Paseo、bb、Lody 作为可选后端。
- Antigravity headless 适配器（`agy -p --output-format json`）。

## 12. 实现与设计的差异（v0.1）

1. MCP 服务内联写在 `.claude-plugin/plugin.json` 的 `mcpServers`，不建根目录 `.mcp.json`：否则用 Claude Code 打开本仓库时，它会被当成项目级 MCP 服务，而 `${CLAUDE_PLUGIN_ROOT}` 在那里无法展开。
2. 观察者（`relay_status` 的 `watch: true`）记在 MCP 服务进程的内存里，不写盘：从未派发过任务的仓库不会多出 `.agenthub/`，多个规划者共用一个仓库时也不会把别人的观察者当成自己的。
3. 取消一律经由 worker 完成：发送 SIGTERM，worker 启动时和每次心跳时也会检查取消标记；worker 已不在时，存活检测把任务对账为 cancelled，而不是 worker-lost。
4. `passEnv` 变量的值在执行者与检查的输出、日志、`final.md` 和存储的补丁里都替换为 `[redacted]`，跨输出块也能识别；执行者把密钥写进仓库文件时，任务会给出警告。
5. light 档的范围不能是整个仓库（`.`）；已完成但尚未 apply 或 discard 的写任务继续占用它的范围。
6. 插件选项键名为 `keep_alive`、`interval_minutes`、`ceiling_hours`、`wake_on_finish`；mod 只为本会话盯过（见过正在运行）的任务发唤醒。

## 13. v0.2：skill 自带脚本，在使用中选择规划者、执行者与模型

起因是第 2 轮架构评审的候选 skill-cli，以及“skill 没法设置模型、也没法决定谁规划谁执行”的反馈。

1. **CLI 走完全流程**：`agents`、`dispatch`、`wait`、`result`、`apply`、`discard`、`cancel`、`status`、`config` 都经 `createRelay().call()`，与 MCP 共用同一套派发顺序和记录；JSON 输出，退出码 0/1/2。`createRelay` 的 `maxWaitSeconds` 让 MCP 保持 50 秒、CLI 最长 3600 秒。
2. **skill 自带 hub**：`skills/agenthub-relay/scripts/` 是 `src/` 的生成副本（`npm run bundle:skill`），复制整个 skill 目录即可使用，测试保证副本与源码一致。`src/` 仍是唯一源码。
3. **规划者身份**：`--planner`、`AGENTHUB_RELAY_PLANNER` 或 MCP 客户端名识别出 claude、codex、dsh、agy 或 unknown，写进任务记录。profile 的选取顺序：`AGENTHUB_RELAY_PROFILE` → 配置里的 `plannerProfiles` → 配置里的 `profile` → 内置的规划者默认（codex → `codex-planner`）→ `thread16`。hub 仍不假设谁在规划，身份只用来选 profile。
4. **模型与推理强度**：档位映射可写 `{executor, model, effort}`，执行者有默认 `model`/`effort` 与参数模板 `modelArgs`/`effortArgs`。单个任务的取值：请求 → 档位映射（仅当执行者相同）→ 执行者默认。没有对应参数的执行者（dsh）以 `model-unsupported`/`effort-unsupported` 失败关闭，不静默忽略。
5. **设置**：用户级文件在下、项目级文件在上；`config set/unset` 只开放 profile、plannerProfiles、档位路由和执行者的 model/effort/command/timeoutMinutes，写前校验，原子替换；`passEnv` 仍只能手改。执行者角色不能改设置。
6. **入口**：`relay-review`、`relay-status`、`relay-config` 三个只能显式调用的薄入口，共用同一脚本；Birdview 启用时 relay-status 只 apply 已确认计划内的任务。
7. 规划者自身的模型由宿主决定，不在本项目范围内。

## 14. Windows 支持

平台差异集中在 `src/platform.mjs`，其余模块只调用它：

1. **找命令与启动**：`resolveCommand` 按 PATH 与 PATHEXT 查找；`.exe` 直接启动；npm/pnpm 的 `.cmd` 外壳读出它包装的脚本，改为 node 加脚本启动，不经 cmd.exe，因此多行任务、引号和 `%` 都原样传递；读不出的外壳以 `windows-shim-unsupported` 失败关闭。
2. **结束进程树**：POSIX 用进程组；Windows 没有进程组，用 `taskkill /pid <pid> /T /F`。子进程以 `windowsHide` 启动，不弹控制台窗口。命令退出后若遗留进程仍占着管道，最多再等 2 秒就收尾。
3. **取消**：worker 每秒读一次取消标记（各平台一致）；Windows 上 `relay_cancel` 不发信号，否则 worker 会先被结束，来不及结束执行者的进程树。
4. **检查**：用 Node 的 `shell` 选项，POSIX 为 /bin/sh，Windows 为 cmd.exe，可用 `checks.shell` 指定其他 shell。
5. **环境变量白名单**补上 Windows 程序需要的变量（SystemRoot、USERPROFILE、APPDATA、TEMP 等），各家 CLI 的登录信息在用户目录下。
6. **原子写**：Windows 在别的进程打开目标文件时会短暂拒绝 rename，写入重试约 1 秒。

## 来源

- [linux.do 话题 3028918](https://linux.do/t/topic/3028918)
- [Claude Code：How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching.md)
- [Claude Code：Mods overview](https://code.claude.com/docs/en/plugins/mods/overview.md)
- [Claude API：Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Claude Code：Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md)
- [Codex：Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [DeepSeek：V4 Flash 更新](https://api-docs.deepseek.com/news/v4-flash)
- [DeepSeek Harness headless README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Antigravity CLI：Headless mode](https://antigravity.google/docs/cli/headless/)
- [Agent Client Protocol：Agents](https://agentclientprotocol.com/get-started/agents)
