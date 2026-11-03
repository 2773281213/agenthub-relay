# 技能兼容性体检

扫描时间: 2026-11-03T15:57:04.222Z

## 兼容性结论：已提供评估

评估对象是 v0.3 的 skill（新增规划者会话：每个会话先列出已保存的分工与模型并等待用户确认）：agenthub-relay（自带脚本，MCP 可选）与三个只能显式调用的入口 relay-review、relay-status、relay-config，和 birdview 三件套一起放在共享目录 .agents/skills 里体检。没有重名，没有元数据问题。relay 系列与 birdview、birdview-review 需要排序：先确认计划或评审方案，再派发、再 apply；上一轮发现的 relay-status 缺少 Birdview 规则已补上。relay-review 与 birdview-review 在只显式调用、不做架构评审的前提下兼容；relay-config 改为会话流程，只写 relay 自己的设置文件，且先问用户、等待答复再确认；会保存修改的确认在 Birdview 计划确认前只用 --reuse 或 --user。安装时只装一份（共享目录），否则同时读 ~/.dsh/skills 与 ~/.agents/skills 的宿主会看到重名。宿主对 disable-model-invocation 的支持只确认了 Claude Code。

发现技能 / 引用正文的文件 / 评估关系: 7 / 7 / 10

结论仅适用于列出的任务场景。已安装不等于当前生效；引用过正文也不代表审查了全部组合。

## 需要关注的关系

评估者 / 评估时间: agent / 2026-11-03T15:57:04.000Z

### birdview / agenthub-relay: 需要排序

- **发生场景:** Birdview 已为本任务启用，规划者要用改版后的 agenthub-relay（脚本或 MCP）派发会改文件的任务。
- **实际影响:** 若先派发，执行者会在用户确认计划前改代码，绕过 Birdview 的确认关口。
- **判断依据:** v0.3 的 agenthub-relay 保留了 With Birdview 规则：先确认计划再派发写任务，只读 review 任务可以提前；与 Birdview 允许确认前做只读调查一致。新增的规划者会话也写明了顺序：session start 只读；会保存修改的 session confirm 会写 relay 的设置文件，所以 Birdview 计划未确认时用 --reuse，或用 --user 保存并说明这不等于批准计划。
- **建议操作:** 保持现有顺序：Birdview 计划确认后再派发 deep/light 任务；会话确认在计划确认前只用 --reuse 或 --user。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): In both auto and on-demand mode, finish the reviewable map and change plan first: show the HTML preview, affected modules/files, intended behavior, applicable constraints, verification plan and remaining uncertainties. Then ask whether to implement this displayed scope and wait for an explicit reply.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): \`session start\` only reads; a \`session confirm\` that saves changed roles writes the relay's settings file, so while Birdview's plan is unconfirmed confirm with \`--reuse\`, or save the change with \`--user\` and say that this does not approve the plan.

### birdview-review / agenthub-relay: 需要排序

- **发生场景:** 架构评审给出候选方案后，规划者想把实现工作派给执行者。
- **实际影响:** 若在用户确认方案前派发，评审会变成自动重构。
- **判断依据:** 上一轮体检指出 relay 原文只说“displayed plan”，没有点名评审方案；v0.2 已把 birdview-review 的方案确认写进同一条规则，歧义消除，置信度由中升为高。
- **建议操作:** 保持现有措辞；先确认评审方案，再派发实现任务。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview-review (.agents/skills/birdview-review/SKILL.md): Generate source-backed diagrams, show the HTML and wait for confirmation of a concrete proposal before implementing; reuse existing approval of the same displayed scope.
- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.

### birdview / relay-status: 需要排序

- **发生场景:** Birdview 启用时，用户用 relay-status 查看任务并决定 apply。
- **实际影响:** apply 会把执行者的改动写进主工作区；只有属于已确认计划的任务才能 apply，并先记录到 Birdview 活动。
- **判断依据:** 上一轮对草稿的体检发现它缺少 Birdview 规则；正式版已写明：Birdview 启用时只 apply 已确认计划内的任务，apply 前记录活动，超出范围先更新计划并重新确认。这与 Birdview 在确认前禁止修改实现文件一致，按顺序执行即可。
- **建议操作:** 先由 Birdview 确认计划，再在 relay-status 里 apply 计划内的任务；计划外的任务先更新计划。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): Before confirmation, read-only investigation and writing map/constraint/plan artifacts are allowed; do not edit implementation, tests or project configuration, or emit \`editing\` events.
- relay-status (.agents/skills/relay-status/SKILL.md): When Birdview is active, apply only jobs that belong to the plan the user confirmed, and record the edit in Birdview's activity before applying; a job outside that plan needs an updated plan and a new confirmation first.

### birdview-review / relay-review: 兼容

- **发生场景:** 用户说“让 Codex 帮忙评审一下架构”这类话，两个名字都带“review”。
- **实际影响:** 若两者都自动触发，可能产出两份互相竞争的评审报告。
- **判断依据:** relay-review 只在用户显式调用时运行（描述写明，并在 Claude Code 里设置 disable-model-invocation），声明不做架构评审，且在架构评审场景把自己的意见交给 birdview-review 合并成一份报告；birdview-review 也要求复用发现、不出竞争报告。Claude Code 会遵守该元数据，其他宿主只能依靠描述文字，所以置信度为中。
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

- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): Executors run in their own git worktrees; your working tree changes only when you apply a job.
- relay-status (.agents/skills/relay-status/SKILL.md): Run \`apply\`, \`discard\` or \`cancel\` only after the user says which.

### birdview / relay-config: 兼容

- **发生场景:** Birdview 正在等待用户确认计划时，用户调用 relay-config 修改执行者或模型设置。
- **实际影响:** relay-config 只写 relay 自己的设置文件（.agenthub/config.json 或用户级文件），不改实现、测试或项目源码；修改设置也不代表批准了 Birdview 的计划。
- **判断依据:** relay-config 只在用户显式调用时运行，改为会话流程：先列出已保存的分工与模型、问用户沿用还是修改并等待答复，复述将确认的内容后才 confirm；它不写任何 agent 自己的配置。Birdview 禁止确认前修改项目配置，保存修改会写 .agenthub/config.json（不进版本库），它是否算“项目配置”取决于理解，所以置信度为中；agenthub-relay 已写明计划未确认时用 --reuse 或 --user。
- **建议操作:** Birdview 计划确认前如需改 relay 设置，用 --user 写用户级文件，或明确告诉用户这不等于确认计划；计划内要用的执行者设置，写进计划的说明里。
- **置信度（AI 判断）:** 中

**原文证据:**

- birdview (.agents/skills/birdview/SKILL.md): Before confirmation, read-only investigation and writing map/constraint/plan artifacts are allowed; do not edit implementation, tests or project configuration, or emit \`editing\` events.
- relay-config (.agents/skills/relay-config/SKILL.md): Ask the user whether to keep these roles or change them, and wait for the answer.

### agenthub-relay / relay-config: 兼容

- **发生场景:** 规划者会话开始时，或用户在会话中途调用 relay-config 想改执行者或模型。
- **实际影响:** 两者走同一个会话流程：列出已保存的配置、问用户、按答复确认；修改先核对再保存。
- **判断依据:** agenthub-relay 要求会话开始先 session start、把分工与模型告诉用户并等待答复、不得替用户决定；relay-config 用同一组命令并同样等待答复。两者对写入设置的门槛一致。已确认的会话不能再次确认，中途改分工需要新开会话，两者都不会绕过这一点。
- **建议操作:** 无需处理。
- **置信度（AI 判断）:** 高

**原文证据:**

- agenthub-relay (.agents/skills/agenthub-relay/SKILL.md): ask whether to keep this or change it. Then wait for the answer. Do not answer for the user, and do not confirm because a default looks reasonable.
- relay-config (.agents/skills/relay-config/SKILL.md): Ask the user whether to keep these roles or change them, and wait for the answer.

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

- .agents/skills

仅覆盖已发现的 SKILL.md。宿主注入规则、引用文档和未发现目录需另行核查。工具校验原文与摘要，语义结论仍是 AI 判断。体检不修改技能配置。
