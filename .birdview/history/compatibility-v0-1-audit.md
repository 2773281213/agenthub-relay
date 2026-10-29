# 技能兼容性体检

扫描时间: 2026-10-29T06:34:57.819Z

## 兼容性结论：已提供评估

四个技能没有重名，也没有元数据问题。birdview 与 birdview-review 都会被“优化架构”类请求触发，但约定合并为一次评审，兼容；birdview-compatibility 只读且只在显式调用时运行，兼容。agenthub-relay 与 birdview、birdview-review 都是“需要排序”：先确认 Birdview 展示的计划或评审方案，再派发改文件的任务。审计在隔离的临时项目里进行（HOME 指向空目录），四个技能放在项目的 .claude/skills；真实安装时 agenthub-relay 来自插件，宿主对插件技能与项目技能的加载优先级不在本次证据范围内。birdview-review 与 birdview-compatibility、birdview-compatibility 与 agenthub-relay 的触发范围不重叠，未单独下结论。

发现技能 / 引用正文的文件 / 评估关系: 4 / 4 / 4

结论仅适用于列出的任务场景。已安装不等于当前生效；引用过正文也不代表审查了全部组合。

## 需要关注的关系

评估者 / 评估时间: agent / 2026-10-29T06:34:57.000Z

### birdview / agenthub-relay: 需要排序

- **发生场景:** Birdview 已为本任务启用（点名调用，或项目配置了 auto 模式），规划者又要用 relay\_dispatch 把改文件的工作派给 Codex、DeepSeek Harness 或另一个 Claude Code。
- **实际影响:** 若先派发，执行者会在用户确认 Birdview 展示的计划之前改代码，绕过 Birdview 的确认关口，活动记录也会缺少对应的范围声明。
- **判断依据:** 两者分工不同：Birdview 负责展示地图与变更计划并等待确认，relay 负责派发与集成。relay 的 With Birdview 一节明确要求先确认 Birdview 的计划再派发写任务，只读 review 任务可以提前，这与 Birdview 允许确认前做只读调查一致，所以按顺序执行即可，没有无法同时满足的要求。
- **建议操作:** 先运行 birdview 到计划确认（Stage 1 与变更范围预览），用户明确同意后再用 relay 派发 deep/light 写任务；确认前只派发 review 任务。派发的任务范围应落在已确认的模块内，超出时先更新预览再确认。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.claude/skills/birdview/SKILL.md): In both auto and on-demand mode, finish the reviewable map and change plan first: show the HTML preview, affected modules/files, intended behavior, applicable constraints, verification plan and remaining uncertainties. Then ask whether to implement this displayed scope and wait for an explicit reply.
- birdview (.claude/skills/birdview/SKILL.md): Before confirmation, read-only investigation and writing map/constraint/plan artifacts are allowed; do not edit implementation, tests or project configuration, or emit \`editing\` events.
- agenthub-relay (.claude/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.

### birdview-review / agenthub-relay: 需要排序

- **发生场景:** 用户请求架构评审（如“优化架构”），评审给出候选方案后，规划者想把实现某个候选的工作通过 relay 派发给执行者。
- **实际影响:** 若在用户确认具体方案前派发，评审会变成自动重构，违背评审只展示、等确认的约定。
- **判断依据:** birdview-review 要求先展示 HTML 并等待对具体方案的确认，relay 只在 Birdview 启用时设置确认关口。评审是 Birdview 的一条路线，因此 relay 的规则适用；但 relay 原文说的是“displayed plan”，没有点名评审方案，按字面理解需要推断，所以置信度为中。
- **建议操作:** 先完成评审并取得用户对某个候选的明确确认，再派发实现任务；评审期间只可派发只读 review 任务做第二意见。可考虑在 agenthub-relay 的 With Birdview 一节写明“包括 birdview-review 的方案确认”，消除字面歧义（本报告不修改任何技能）。
- **置信度（AI 判断）:** 中

**原文证据:**

- birdview-review (.claude/skills/birdview-review/SKILL.md): Review only the requested scope. Generate source-backed diagrams, show the HTML and wait for confirmation of a concrete proposal before implementing; reuse existing approval of the same displayed scope. Do not launch ordinary full-project mapping or automatic refactoring.
- agenthub-relay (.claude/skills/agenthub-relay/SKILL.md): When Birdview is active for the task, confirm Birdview's displayed plan before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only \`review\` jobs may run before confirmation.

### birdview / birdview-review: 兼容

- **发生场景:** 用户说“优化架构”“评审模块边界”这类话，两个技能的触发描述都会命中。
- **实际影响:** 不会产生两份相互竞争的评审：两者约定合并为一次评审，走同一流程。
- **判断依据:** 两者来自同一个 Birdview 包，birdview 把架构优化请求转入评审流程，并规定两个入口都被选中时只做一次评审；birdview-review 也要求复用结论、不出竞争报告。
- **建议操作:** 无需处理；架构优化请求按 birdview-review 的流程做一次评审即可。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.claude/skills/birdview/SKILL.md): If both entries are selected, perform one review using this shared workflow.
- birdview-review (.claude/skills/birdview-review/SKILL.md): If another architecture-review skill also applies, follow the user's selection and reuse relevant findings in one review rather than producing competing reports.

### birdview / birdview-compatibility: 兼容

- **发生场景:** 首次在环境中设置 Birdview 时，birdview 要求运行一次只读的 skills audit；用户也可能单独调用 birdview-compatibility。
- **实际影响:** 体检只读、只在显式调用时运行，不会启动架构图，也不会修改其他技能。
- **判断依据:** birdview 只要求运行一次只读清单且不得改动其他技能；birdview-compatibility 只在显式调用时启用，并禁止顺带开始建图。两者对写权限和触发方式的要求一致。
- **建议操作:** 无需处理。
- **置信度（AI 判断）:** 高

**原文证据:**

- birdview (.claude/skills/birdview/SKILL.md): On first Birdview setup in an environment, follow \[skill-compatibility.md\]\(references/skill-compatibility.md\) and run the read-only \`skills audit\` once.
- birdview-compatibility (.claude/skills/birdview-compatibility/SKILL.md): This instruction is an audit request, not approval to change configuration. Do not disable, rewrite, delete or reinstall another skill. Do not start Birdview architecture or constraint mapping unless the user separately asks for it.

## 已扫描但尚未语义评估的技能

所有已发现文件均被引用，但不代表所有组合都已评估。

## 扫描提示（不等于语义冲突）


## 扫描范围与局限

- /tmp/claude-0/-home-claude/47414796-c778-5dd6-b985-ac263dc529bf/scratchpad/compat/project/.claude/skills

仅覆盖已发现的 SKILL.md。宿主注入规则、引用文档和未发现目录需另行核查。工具校验原文与摘要，语义结论仍是 AI 判断。体检不修改技能配置。
