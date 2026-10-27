# agenthub-relay agent instructions

These rules apply to every agent working in this repository, whichever agent is planning and whichever is executing (Claude Code, Codex, DeepSeek Harness, Antigravity or another MCP client). The design they protect is described in [docs/design.md](docs/design.md).

## Architecture rules

- Keep the hub planner-neutral: code under `src/` must not assume which agent is the planner; Claude Code specific behavior lives only in `hooks/`, `types/` and `.claude-plugin/`.
- Use no runtime dependencies: the hub ships as plain ESM JavaScript for Node.js 20 or newer, and code under `src/` imports only the Node.js standard library.
- Treat Antigravity (`agy`) and the generic ACP executor as reserved in v0.1: dispatching to a reserved executor must fail closed with an error that names the reason.

## Execution safety rules

- Run every executor inside its own git worktree under `.agenthub/worktrees/`; the main working tree may change only through `relay_apply`.
- Refuse a `light` tier job unless it declares an explicit file scope and at least one check command.
- Refuse a write job whose scope overlaps the scope of an active write job, using directory-prefix matching (`src/api` covers `src/api/x.ts` but not `src/api-other.ts`).
- Mark executor processes with `AGENTHUB_RELAY_ROLE=executor`; in that role the hub must refuse `relay_dispatch` and the Claude Code mod must stay inactive.
- Pass secrets only by environment variable name; never write API keys or environment values into job records, logs, events or test fixtures.

## Verification rules

- Record checks with Birdview semantics: `passed` requires exit code 0, `failed` requires a non-zero exit code and `not-run` requires a null exit code; a job with any failed check ends as `failed`, and a job without checks is reported as unverified.
- Ship every behavior change with a `node --test` test that exercises observable behavior through public interfaces; changes to `hooks/` also need `claude plugin test` coverage.

## Cache keep-alive rules

- Keep the Claude Code planner's prompt cache warm only through `$.model.fork`, only while relay jobs are running, never once the cache is presumed cold, and never beyond the configured ceiling; keep-alive must not add turns to the transcript.
