# 技能兼容性体检

扫描时间: 2026-10-29T08:53:32.357Z

## 兼容性结论：已提供评估

评估对象是拟议方案的草稿：改版后的 agenthub-relay（自带脚本，MCP 可选）和两个只能显式调用的薄入口 relay-review、relay-status，与 birdview 三件套一起放在共享目录 .agents/skills 里体检。没有重名，没有元数据问题。结论：relay 系列与 birdview、birdview-review 需要排序（先确认计划或评审方案再派发、再 apply），relay-review 与 birdview-review 在只显式调用、不做架构评审的前提下兼容。草稿有一处缺口：relay-status 没写 Birdview 规则，apply 可能绕过计划确认，需补上。另做了一次重复安装模拟：同一个 skill 同时装进 ~/.agents/skills 和 ~/.dsh/skills 时，清单报告重名，因此安装命令应只装共享目录一份。草稿不是已发布的技能，宿主对 disable-model-invocation 的支持只确认了 Claude Code。

发现技能 / 引用正文的文件 / 评估关系: 6 / 6 / 8

结论仅适用于列出的任务场景。已安装不等于当前生效；引用过正文也不代表审查了全部组合。

## 需要关注的关系

评估者 / 评估时间: agent / 2026-10-29T08:53:32.000Z

### birdview / agenthub-relay: 需要排序

- **发生场景:** Birdview 已为本任务启用，规划者要用改版后的 agenthub-relay（脚本或 MCP）派发会改文件的任务。
- **实际影响:** 若先派发，执行者会在用户确认计划前改代码，绕过 Birdview 的确认关口。
- **判断依据:** 改版草稿保留了现有的 With Birdview 规则：先确认计划再派发写任务，只读 review 任务可以提前；与 Birdview 允许确认前做只读调查一致。改用脚本不影响这个顺序。
- **建议操作:** 保持现有顺序：Birdview 计划确认后再派发 deep/light 任务。实现时把这一条原样保留在新版 SKILL.md。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): In both auto and on-demand mode, finish the reviewable map and change plan first: show the HTML preview, affected modules/files, intended behavior, applicable constraints, verification plan and remaining uncertainties. Then ask whether to implement this displayed scope and wait for an explicit reply.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.

### birdview-review / agenthub-relay: 需要排序

- **发生场景:** 架构评审给出候选方案后，规划者想把实现工作派给执行者。
- **实际影响:** 若在用户确认方案前派发，评审会变成自动重构。
- **判断依据:** 上一轮体检指出 relay 原文只说“displayed plan”，没有点名评审方案；草稿已把 birdview-review 的方案确认写进同一条规则，歧义消除，置信度由中升为高。
- **建议操作:** 采用草稿里的措辞；先确认评审方案，再派发实现任务。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview-review (.agents/skills/birdview-review/SKILL.md): Generate source-backed diagrams, show the HTML and wait for confirmation of a concrete proposal before implementing; reuse existing approval of the same displayed scope.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.

### birdview / relay-status: 需要排序

- **发生场景:** Birdview 启用时，用户用 relay-status 查看任务并决定 apply。
- **实际影响:** apply 会把执行者的改动写进主工作区；若该任务不在已确认的计划范围内，就等于绕过 Birdview 改了代码，活动记录也缺少对应的 editing 事件。
- **判断依据:** Birdview 在确认前禁止修改实现文件；relay-status 草稿只要求用户同意后再 apply，但没有提到 Birdview。用户同意 apply 不等于确认了 Birdview 的计划，需要补一条顺序规则。
- **建议操作:** 在 relay-status 草稿中加入：Birdview 启用时，只 apply 属于已确认计划的任务，并在 apply 前记录 editing 事件；超出范围先更新计划再确认。
- **置信度（AI 判断）:** 中

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): Before confirmation, read-only investigation and writing map/constraint/plan artifacts are allowed; do not edit implementation, tests or project configuration, or emit \`editing\` events.
- relay-status (.agents/skills/relay-status/SKILL.md): run \`apply\`, \`discard\` or \`cancel\` only after the user says which.

### birdview-review / relay-review: 兼容

- **发生场景:** 用户说“让 Codex 帮忙评审一下架构”这类话，两个名字都带“review”。
- **实际影响:** 若两者都自动触发，可能产出两份互相竞争的评审报告。
- **判断依据:** relay-review 草稿只在用户显式调用时运行（描述写明，并在 Claude Code 里设置 disable-model-invocation），声明不做架构评审，且在架构评审场景把自己的意见交给 birdview-review 合并成一份报告；birdview-review 也要求复用发现、不出竞争报告。Claude Code 会遵守该元数据，其他宿主只能依靠描述文字，所以置信度为中。
- **建议操作:** relay-review 保持仅显式调用，描述里保留“does not review architecture”；架构问题走 birdview-review，需要另一家意见时再把 relay-review 的结果并入同一份评审。
- **置信度（AI 判断）:** 中

**原文证据:**

- birdview-review (.agents/skills/birdview-review/SKILL.md): If another architecture-review skill also applies, follow the user's selection and reuse relevant findings in one review rather than producing competing reports.
- relay-review (.agents/skills/relay-review/SKILL.md): When the user asks for an architecture review, birdview-review owns the report; offer this second opinion as an input to that one review instead of producing a separate report.

### agenthub-relay / relay-review: 兼容

- **发生场景:** 用户在派发写任务的同时，用 relay-review 请另一家做只读复核。
- **实际影响:** 复核任务不会改动工作区，也不占用写任务的范围。
- **判断依据:** relay-review 只派发 review 档任务，任何改动都记为越界且不会 apply；agenthub-relay 允许只读 review 任务在确认前运行。两者共用同一个脚本，没有相互冲突的写权限。
- **建议操作:** 无需处理；relay-review 作为 agenthub-relay 的薄入口即可。
- **置信度（AI 判断）:** 高

**原文证据:**

- relay-review (.agents/skills/relay-review/SKILL.md): A review job is read-only: any change it makes is reported out of scope and is never applied.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): Read-only \`review\` jobs may run before confirmation.

### agenthub-relay / relay-status: 兼容

- **发生场景:** 用户用 relay-status 查看 agenthub-relay 派发的任务并决定去留。
- **实际影响:** 只有用户点头后才会改动主工作区。
- **判断依据:** agenthub-relay 规定主工作区只在 apply 时改变；relay-status 只在用户明确选择后执行 apply、discard 或 cancel。两者对写入时机的要求一致。
- **建议操作:** 无需处理。
- **置信度（AI 判断）:** 高

**原文证据:**

- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): Executors run in their own git worktrees; your working tree changes only when you run \`apply\`.
- relay-status (.agents/skills/relay-status/SKILL.md): run \`apply\`, \`discard\` or \`cancel\` only after the user says which.

### birdview / birdview-review: 兼容

- **发生场景:** 用户说“优化架构”这类话，两个技能的触发描述都会命中。
- **实际影响:** 两者约定合并为一次评审，不会出两份报告。
- **判断依据:** 与上一轮体检相同：同一个 Birdview 包，birdview 把架构优化请求转入评审流程，并规定两个入口都被选中时只做一次评审。
- **建议操作:** 无需处理。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): If both entries are selected, perform one review using this shared workflow.
- birdview-review (.agents/skills/birdview-review/SKILL.md): If another architecture-review skill also applies, follow the user's selection and reuse relevant findings in one review rather than producing competing reports.

### birdview / birdview-compatibility: 兼容

- **发生场景:** 首次设置 Birdview 或用户单独调用体检。
- **实际影响:** 体检只读、只在显式调用时运行，不会启动架构图，也不会修改其他技能。
- **判断依据:** 与上一轮体检相同。
- **建议操作:** 无需处理。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): On first Birdview setup in an environment, follow \[skill-compatibility.md\]\(references/skill-compatibility.md\) and run the read-only \`skills audit\` once.
- birdview-compatibility (.agents/skills/birdview-compatibility/SKILL.md): This instruction is an audit request, not approval to change configuration. Do not disable, rewrite, delete or reinstall another skill. Do not start Birdview architecture or constraint mapping unless the user separately asks for it.

## 已扫描但尚未语义评估的技能

所有已发现文件均被引用，但不代表所有组合都已评估。

## 扫描提示（不等于语义冲突）


## 扫描范围与局限

- /tmp/claude-0/-home-claude/47414796-c778-5dd6-b985-ac263dc529bf/scratchpad/compat2/project/.agents/skills

仅覆盖已发现的 SKILL.md。宿主注入规则、引用文档和未发现目录需另行核查。工具校验原文与摘要，语义结论仍是 AI 判断。体检不修改技能配置。
