# agenthub-relay

[中文](#中文) · [English](#english)

## 中文

agenthub-relay 是一个**中立的 agent 调度 hub**：规划者通过 MCP 调用 `relay_*` 工具，把编码任务派给 Codex、Claude Code 或 DeepSeek Harness；每个任务在独立的 git worktree 里执行，规划者看过结果后再决定 apply 或 discard。附带一个 Claude Code mod：Claude Code 当规划者、等待其他 agent 时，每 55 分钟保活一次主会话的提示缓存，任务结束时唤醒会话。


### 工作方式

```
规划者（Claude Code / Codex / DeepSeek Harness / Antigravity）
   │  MCP：relay_dispatch / relay_wait / relay_result / relay_apply …
   ▼
agenthub-relay ── 派发策略（档位、范围、冲突、角色）
   │               任务存储（.agenthub/jobs，原子写、心跳）
   │               Git 隔离（每任务一个 worktree，补丁 apply/discard）
   ▼  分离的 worker 进程（进程组、超时、取消、检查）
执行者：codex exec --json │ claude -p --output-format json │ dsh --profile headless
```

| 档位 | 用途 | 必填 | 默认执行者（`thread16` profile） |
|---|---|---|---|
| `deep` | 复杂、多文件、需要推理的工作 | `scope`（`"."` 表示整个仓库） | `codex` |
| `light` | 简单明确的机械性工作 | 1–10 条 `scope` 和至少一条检查命令 | `dsh`（DeepSeek V4 Flash） |
| `review` | 只读调研或第二意见 | 无；任何改动都记为越界 | `claude` |

护栏：执行者只能改自己的 worktree，主工作区只经 `relay_apply` 改变；并发写任务的范围按目录前缀判断，重叠即拒绝；执行者进程带 `AGENTHUB_RELAY_ROLE=executor`，不能再派发；密钥只按变量名透传，不写进任何记录；Antigravity 和通用 ACP 在 v0.1 只预留，派发时失败关闭。检查按 Birdview 语义记录：通过要求退出码 0，失败要求非 0，未运行时退出码为 null；没有检查的任务记为"未验证"。

### 安装

需要 Node.js 20 以上和 git，再加至少一个执行者 CLI（已登录的 `codex`、`claude` 或 `dsh`）。

Claude Code（插件里包含 MCP 服务、保活 mod 和路由手册），在终端会话的输入框里：

```
/plugin install agenthub-relay --marketplace 2773281213/agenthub-relay
```

在 shell 里：`claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay`。Codex、DeepSeek Harness、Antigravity 当规划者的配置见 [docs/planners.md](docs/planners.md)。

检查环境：在仓库目录运行 `node /path/to/agenthub-relay/src/cli.mjs doctor`。

### 配置（可选）

`.agenthub/config.json`（第一次派发时，hub 会把 `.agenthub/` 写进 `.git/info/exclude`，此后它不会出现在 git status 里）：

```json
{
  "profile": "thread16",
  "executors": {
    "codex": { "passEnv": ["CODEX_API_KEY"], "timeoutMinutes": 90 },
    "claude": { "command": "/usr/local/bin/claude" }
  }
}
```

### 使用

1. `relay_dispatch`：写一个自包含的任务（目标、相关文件、约束、验收、检查命令）。
2. 等待：返回里 `watcher.active` 为 true 时直接结束本轮，mod 会在任务结束时唤醒你；否则反复调用 `relay_wait`。
3. `relay_result` 看摘要、检查、改动和越界文件，必要时读补丁。
4. `relay_apply`（改动以未暂存状态进入工作区）或 `relay_discard`。

### Birdview

本仓库按 [Birdview](https://github.com/Qiuner/birdview) 的三个 skill 标准设计：`.birdview/` 里有架构图与约束图（`architecture.html`）、实现过程的变更活动（`activity.html`）、架构评审（`review.html`）和 skill 兼容性报告（`compatibility-audit.md`）。用浏览器直接打开 HTML 即可。

### 开发

```
npm test                 # node --test：策略、存储、适配器、真实 git 加伪造执行者的集成、MCP 协议
claude plugin test .     # mod 测试（模拟时钟）
claude plugin validate . # 插件清单与 hooks 模块
```

### 已知限制

- 真实的 Codex 和 dsh 没有在本仓库的测试环境里跑过：适配器按各自官方文档写成，用伪造的二进制做契约测试。
- 范围声明和越界审计是事后核对，不是文件系统写锁；不支持 Windows。
- `$.model.fork` 是否会重置 Claude Code 的空闲压缩计时尚无文档，mod 会记录压缩事件，`/relay` 可以查看。

## English

agenthub-relay is a **planner-neutral hub**: a planner calls the `relay_*` MCP tools to hand coding jobs to Codex, Claude Code or DeepSeek Harness. Each job runs in its own git worktree, and the planner reads the result before applying or discarding it. A Claude Code mod keeps a waiting Claude Code planner's prompt cache warm with a refresh every 55 minutes, and wakes the session when a job ends.

### Where it comes from

From the visible 16th reply of [linux.do topic 3028918](https://linux.do/t/topic/3028918): let Claude Code plan, give complex work to Codex and simple, clear work to DeepSeek V4 Flash, and write a mod that keeps the cache alive every 55 minutes while waiting. The idea holds with three corrections: DeepSeek's current model name is `deepseek-flash` (`deepseek-v4-flash` still works); the 55-minute keep-alive only works on the one-hour cache TTL (the default within a subscription's plan usage; set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` on an API key, usage credits or a cloud provider); and the refresh uses a mod's `$.model.fork`, which re-reads the main thread's cached prefix without adding turns. None of the tools the reply names covers Claude Code, Codex, DeepSeek Harness and Antigravity with interchangeable planner and executor roles, so v0.1 is its own hub and v0.2's generic ACP executor will bring them in as optional backends.

### Tiers

`deep` (complex work; scope required) defaults to `codex`; `light` (simple, clearly specified work; 1-10 scope paths and at least one check) to `dsh` with DeepSeek V4 Flash; `review` (read-only) to `claude`. Executors only write in their own worktree; your working tree changes only through `relay_apply`. Overlapping write scopes are refused, executors cannot dispatch, credentials pass only by variable name, and `agy` and ACP are reserved and fail closed. Checks follow Birdview's semantics, and a job without checks is reported unverified.

### Install

Node.js 20 or newer, git, and at least one signed-in executor CLI (`codex`, `claude` or `dsh`). For Claude Code, at the prompt of a terminal session:

```
/plugin install agenthub-relay --marketplace 2773281213/agenthub-relay
```

From a shell: `claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay`. In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `2773281213/agenthub-relay`, then Add plugin. For Codex, DeepSeek Harness and Antigravity as planners see [docs/planners.md](docs/planners.md). Run `node /path/to/agenthub-relay/src/cli.mjs doctor` in a repository to check the setup.

### Use

Dispatch a self-contained task with `relay_dispatch`; if the result says `watcher.active`, end your turn and the mod wakes you, otherwise call `relay_wait`; read `relay_result`; then `relay_apply` (changes land unstaged) or `relay_discard`. The [routing skill](skills/agenthub-relay/SKILL.md) says this in full. Keep-alive details: [docs/cache-keepalive.md](docs/cache-keepalive.md).

### Develop

`npm test`, `claude plugin test .` and `claude plugin validate .`. Architecture, constraints, the implementation activity, the architecture review and the skill compatibility report are in `.birdview/`, following [Birdview](https://github.com/Qiuner/birdview)'s three skills.

### Limitations

Real Codex and dsh runs are not part of the test suite: their adapters follow each CLI's documentation and are contract-tested against a fake executor. Scope declarations and the out-of-scope audit are checks after the fact, not filesystem locks. Windows is not supported. Whether a fork resets Claude Code's idle-compaction timer is undocumented; the mod records compactions and `/relay` shows them.

## License

MIT
