# agenthub-relay

[中文](#中文) · [English](#english)

## 中文

agenthub-relay 是一个**中立的 agent 调度 hub**：规划者通过 skill 自带的脚本（或 MCP 的 `relay_*` 工具）把编码任务派给 Codex、Claude Code 或 DeepSeek Harness；每个任务在独立的 git worktree 里执行，规划者看过结果后再决定 apply 或 discard。谁当规划者、每个档位给哪个执行者、用什么模型，都能在使用中按对话调整。附带一个 Claude Code mod：Claude Code 当规划者、等待其他 agent 时，每 55 分钟保活一次主会话的提示缓存，任务结束时唤醒会话。

### 工作方式

```
规划者（Claude Code / Codex / DeepSeek Harness / Antigravity）
   │  skill 脚本：node scripts/cli.mjs dispatch / wait / result / apply …
   │  或 MCP：relay_dispatch / relay_wait / relay_result / relay_apply …
   ▼
agenthub-relay ── 配置（规划者 → profile → 各档位的执行者、模型、推理强度）
   │               派发策略（档位、范围、冲突、角色）
   │               任务存储（.agenthub/jobs，原子写、心跳）
   │               Git 隔离（每任务一个 worktree，补丁 apply/discard）
   ▼  分离的 worker 进程（进程组、超时、取消、检查）
执行者：codex exec --json │ claude -p --output-format json │ dsh --profile headless
```

| 档位 | 用途 | 必填 | 默认执行者（`thread16` / `codex-planner`） |
|---|---|---|---|
| `deep` | 复杂、多文件、需要推理的工作 | `scope`（`"."` 表示整个仓库） | `codex` / `claude` |
| `light` | 简单明确的机械性工作 | 1–10 条 `scope` 和至少一条检查命令 | `dsh`（DeepSeek V4 Flash） |
| `review` | 只读调研或第二意见 | 无；任何改动都记为越界 | `claude` / `codex` |

护栏：执行者只能改自己的 worktree，主工作区只经 apply 改变；并发写任务的范围按目录前缀判断，重叠即拒绝；执行者进程带 `AGENTHUB_RELAY_ROLE=executor`，不能再派发，也不能改设置；密钥只按变量名透传，不写进任何记录；Antigravity 和通用 ACP 只预留，派发时失败关闭。检查按 Birdview 语义记录：通过要求退出码 0，失败要求非 0，未运行时退出码为 null；没有检查的任务记为“未验证”。

### 安装

需要 Node.js 20 以上和 git，再加至少一个执行者 CLI（已登录的 `codex`、`claude` 或 `dsh`）。

- **任何规划者（Codex、DeepSeek Harness、Antigravity、Claude Code）**：安装 skill，不用配置 MCP。
  ```
  npx skills add 2773281213/agenthub-relay --skill agenthub-relay
  ```
  或者把 `skills/agenthub-relay` 整个目录复制到规划者读取 skill 的位置：Codex 与 Antigravity 读 `~/.agents/skills`，DeepSeek Harness 读 `~/.dsh/skills` 或 `~/.agents/skills`（只装一份，避免重名），Claude Code 读 `~/.claude/skills`。另外三个只能手动调用的入口 `relay-review`、`relay-status`、`relay-config` 也在 `skills/` 下，按需一起复制。
- **Claude Code 插件**（包含四个 skill、MCP 服务、保活 mod 和 `/relay`），在终端会话的输入框里：
  ```
  /plugin install agenthub-relay --marketplace 2773281213/agenthub-relay
  ```
  在 shell 里：`claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay`。

各规划者的细节见 [docs/planners.md](docs/planners.md)。检查环境：在仓库目录运行 `node <skill 目录>/scripts/cli.mjs doctor`。

### 使用

规划者按 [skill](skills/agenthub-relay/SKILL.md) 的说明调用脚本，每条命令都带 `--planner <自己>`：

```sh
R="node ~/.agents/skills/agenthub-relay/scripts/cli.mjs"
$R config show --planner codex                      # 看自己会用哪个 profile、各档位给谁、用什么模型
echo "<自包含的任务说明>" | $R dispatch --tier light --scope src/x.ts --check "npm test -- x" --task-file - --planner codex
$R wait --planner codex                             # 默认 50 秒，--timeout 最长 3600 秒
$R result <jobId>                                   # 摘要、检查、改动与越界文件、补丁路径
$R apply <jobId>                                    # 或 discard / cancel
```

Claude Code 带插件时也可以直接用 `relay_*` 工具：派发结果里 `watcher.active` 为 true 就结束本轮，mod 会在任务结束时唤醒你。

### 选择规划者、执行者与模型

- **规划者**：`--planner` 或 `AGENTHUB_RELAY_PLANNER` 指明是谁在规划；MCP 客户端按握手时报的名字识别（如 `codex-mcp-client` → codex）。内置规则：Claude Code 规划用 `thread16`（深任务给 Codex），Codex 规划用 `codex-planner`（深任务给 Claude Code），可用 `plannerProfiles` 改。
- **单个任务**：`dispatch --executor claude --model opus --effort high`。codex 用 `-m` 与 `-c model_reasoning_effort`，claude 用 `--model` 与 `--effort`；DeepSeek Harness 没有文档化的按次选模型参数（模型在它自己的 `settings.yaml` 里），指定时会以 `model-unsupported` 拒绝。
- **长期设置**：`config set profiles.thread16.deep claude:opus@high`、`config set executors.codex.model <名字>`、`config set plannerProfiles.codex thread16`；加 `--user` 存到 `~/.config/agenthub-relay/config.json`，对所有项目生效，否则存在本仓库的 `.agenthub/config.json`（第一次派发时 hub 会把 `.agenthub/` 写进 `.git/info/exclude`）。项目设置覆盖用户设置。`/relay-config` 用对话完成这些修改。
- **规划者自己的模型**由宿主决定（Claude Code 用 `/model`），这里改不了。

手写配置的例子（`passEnv` 只能手写，只写变量名）：

```json
{
  "plannerProfiles": { "codex": "codex-planner" },
  "profiles": { "thread16": { "deep": { "executor": "codex", "model": "gpt-5.1-codex", "effort": "high" } } },
  "executors": {
    "codex": { "passEnv": ["CODEX_API_KEY"], "timeoutMinutes": 90 },
    "claude": { "model": "sonnet" }
  }
}
```

### Birdview

本仓库按 [Birdview](https://github.com/Qiuner/birdview) 的三个 skill 标准设计：`.birdview/` 里有架构图与约束图（`architecture.html`）、实现过程的变更活动（`activity.html` 与 `activity-skill-cli.html`）、架构评审（`review.html`）和 skill 兼容性报告（`compatibility-audit.md`）。用浏览器直接打开 HTML 即可。

### 开发

```
npm test                 # node --test：配置、策略、存储、适配器、CLI、skill 副本、真实 git 加伪造执行者的集成、MCP 协议
npm run bundle:skill     # 改了 src/ 之后重新生成 skills/agenthub-relay/scripts/
claude plugin test .     # mod 测试（模拟时钟）
claude plugin validate . # 插件清单与 hooks 模块
```

`src/` 是唯一的源码；`skills/agenthub-relay/scripts/` 是生成的副本，不要手改。

### 已知限制

- 真实的 Codex、dsh 没有在本仓库的测试环境里跑过：适配器按各自官方文档写成，用伪造的二进制做契约测试；codex 的推理强度参数写法来自其 `-c` 配置覆盖方式，未在真实 CLI 上验证。
- 只有 Claude Code 会遵守 `disable-model-invocation`；其他宿主靠 skill 描述里的“仅在用户调用时使用”。
- Claude Code 以外的规划者没有保活，用 `wait` 轮询。
- 范围声明和越界审计是事后核对，不是文件系统写锁；不支持 Windows。
- `$.model.fork` 是否会重置 Claude Code 的空闲压缩计时尚无文档，mod 会记录压缩事件，`/relay` 可以查看。

## English

agenthub-relay is a **planner-neutral hub**: a planner runs the script bundled with the skill (or calls the `relay_*` MCP tools) to hand coding jobs to Codex, Claude Code or DeepSeek Harness. Each job runs in its own git worktree, and the planner reads the result before applying or discarding it. Who plans, which executor each tier goes to and which model it runs can all be chosen during use. A Claude Code mod keeps a waiting Claude Code planner's prompt cache warm with a refresh every 55 minutes, and wakes the session when a job ends.

### Where it comes from

From the visible 16th reply of [linux.do topic 3028918](https://linux.do/t/topic/3028918): let Claude Code plan, give complex work to Codex and simple, clear work to DeepSeek V4 Flash, and write a mod that keeps the cache alive every 55 minutes while waiting. The idea holds with three corrections: DeepSeek's current model name is `deepseek-flash` (`deepseek-v4-flash` still works); the 55-minute keep-alive only works on the one-hour cache TTL (the default within a subscription's plan usage; set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` on an API key, usage credits or a cloud provider); and the refresh uses a mod's `$.model.fork`, which re-reads the main thread's cached prefix without adding turns. None of the tools the reply names covers Claude Code, Codex, DeepSeek Harness and Antigravity with interchangeable planner and executor roles, so this is its own hub; a generic ACP executor will bring them in as optional backends later.

### Tiers

`deep` (complex work; scope required) defaults to `codex` (`claude` when Codex plans); `light` (simple, clearly specified work; 1-10 scope paths and at least one check) to `dsh` with DeepSeek V4 Flash; `review` (read-only) to `claude` (`codex` when Codex plans). Executors only write in their own worktree; your working tree changes only through apply. Overlapping write scopes are refused, executors can neither dispatch nor change settings, credentials pass only by variable name, and `agy` and ACP are reserved and fail closed. Checks follow Birdview's semantics, and a job without checks is reported unverified.

### Install

Node.js 20 or newer, git, and at least one signed-in executor CLI (`codex`, `claude` or `dsh`).

- **Any planner (Codex, DeepSeek Harness, Antigravity, Claude Code)**: install the skill; no MCP setup is needed. `npx skills add 2773281213/agenthub-relay --skill agenthub-relay`, or copy the whole `skills/agenthub-relay` folder to where your planner reads skills: `~/.agents/skills` for Codex and Antigravity, `~/.dsh/skills` or `~/.agents/skills` for DeepSeek Harness (one copy only, to avoid duplicate names), `~/.claude/skills` for Claude Code. The explicit-only entries `relay-review`, `relay-status` and `relay-config` sit next to it in `skills/`.
- **Claude Code plugin** (the four skills, the MCP server, the keep-alive mod and `/relay`): `/plugin install agenthub-relay --marketplace 2773281213/agenthub-relay` at the prompt, or `claude plugin install agenthub-relay --marketplace 2773281213/agenthub-relay` from a shell.

See [docs/planners.md](docs/planners.md) for each planner. Run `node <skill folder>/scripts/cli.mjs doctor` in a repository to check the setup.

### Use

Follow the [routing skill](skills/agenthub-relay/SKILL.md): `config show`, then `dispatch` a self-contained task (on stdin with `--task-file -`), `wait`, read `result`, and `apply` (changes land unstaged) or `discard`, passing `--planner <you>` on each command. With the Claude Code plugin you may use the `relay_*` tools instead; if a dispatch result says `watcher.active`, end your turn and the mod wakes you. Keep-alive details: [docs/cache-keepalive.md](docs/cache-keepalive.md).

### Choosing planner, executors and models

`--planner` (or `AGENTHUB_RELAY_PLANNER`, or the MCP client name) selects a profile: a Claude Code planner gets `thread16`, a Codex planner `codex-planner`, unless `plannerProfiles` says otherwise. A single job takes `--executor`, `--model` and `--effort` (codex: `-m`, `-c model_reasoning_effort`; claude: `--model`, `--effort`; DeepSeek Harness has no documented per-run model flag and refuses one). Lasting choices go through `config set` (`profiles.<name>.<tier>` as `executor[:model][@effort]`, `executors.<id>.model`, `plannerProfiles.<planner>`, `profile`), in the project's `.agenthub/config.json` or, with `--user`, in `~/.config/agenthub-relay/config.json`; `/relay-config` does this in conversation. The planner's own model is the host's to set (`/model` in Claude Code).

### Develop

`npm test`, `npm run bundle:skill` after changing `src/` (the skill's `scripts/` folder is a generated copy), `claude plugin test .` and `claude plugin validate .`. Architecture, constraints, the implementation activity, the architecture review and the skill compatibility report are in `.birdview/`, following [Birdview](https://github.com/Qiuner/birdview)'s three skills.

### Limitations

Real Codex and dsh runs are not part of the test suite: their adapters follow each CLI's documentation and are contract-tested against a fake executor, and codex's effort flag follows its `-c` configuration override without a real run. Only Claude Code honors `disable-model-invocation`. Planners other than Claude Code have no keep-alive and poll with `wait`. Scope declarations and the out-of-scope audit are checks after the fact, not filesystem locks. Windows is not supported. Whether a fork resets Claude Code's idle-compaction timer is undocumented; the mod records compactions and `/relay` shows them.

## License

MIT
