# agenthub-relay agent instructions

These rules apply to every agent working in this repository, whichever agent is planning and whichever is executing (Claude Code, Codex, DeepSeek Harness, Antigravity or another MCP client). The design they protect is described in [docs/design.md](docs/design.md).

## Architecture rules

- Keep the hub planner-neutral: code under `src/` must not assume which agent is the planner; Claude Code specific behavior lives only in `hooks/`, `types/` and `.claude-plugin/`.
- Use no runtime dependencies: the hub ships as plain ESM JavaScript for Node.js 20 or newer, and code under `src/` imports only the Node.js standard library.
- Treat the generic ACP executor as reserved until its adapter exists: dispatching to a reserved executor must fail closed with an error that names the reason.
- Reach Gemini models only through Antigravity (the `agy` executor, Antigravity CLI); do not add a Gemini CLI executor or take Gemini CLI for the Antigravity planner.
- Generate `skills/agenthub-relay/scripts/` from `src/` with `npm run bundle:skill` and never edit that copy by hand; it must stay identical to `src/`, which `npm test` checks.

## Execution safety rules

- Run every executor inside its own git worktree under `.agenthub/worktrees/`; the main working tree may change only through `relay_apply`.
- Refuse a `light` tier job unless it declares an explicit file scope and at least one check command.
- Refuse a write job whose scope overlaps the scope of an active write job, using directory-prefix matching (`src/api` covers `src/api/x.ts` but not `src/api-other.ts`).
- Mark executor processes with `AGENTHUB_RELAY_ROLE=executor`; in that role the hub must refuse dispatching, sending to, taking over, collecting, applying, discarding and cancelling jobs, starting or confirming planner sessions and changing the relay settings, an executor's `relay_result` must not count as the planner's read, and the Claude Code mod must stay inactive.
- Resolve a relay run from inside a job's worktree (`<owner>/.agenthub/worktrees/<id>`) to the repository that created the job (which may itself be a linked worktree), whose jobs it belongs to; any other linked worktree keeps its own relay.
- Pass secrets only by environment variable name; never write API keys or environment values into job records, logs, events or test fixtures.
- Dispatch only inside a planner session the user confirmed: refuse a dispatch without a confirmed session unless `sessions.required` is false, and refuse a caller identified as another agent than the session's planner.
- Read other agents' own settings files (Codex `config.toml`, Claude Code `settings.json`, DeepSeek Harness `settings.yaml`) only to report their models; never write them.
- Continue a job only in the executor's own native session and in the job's own worktree; a job whose executor reported no session fails closed (`resume-unsupported`), and a follow-up is refused once the job is applied or discarded.
- Send nothing to a taken-over job until it is collected or the planner forces it; a taken-over job keeps its scope, apply refuses it, and discard needs force.
- Change a job's status, integration or turn only in one store update that checks the current state first; never hold a lock while waiting for a turn to stop, and never run git on the main tree while another process may snapshot it (apply holds the dispatch lock for `git apply`).
- Find an executor outside PATH only for its built-in command name; never replace a command the user configured.
- An `#executor` mention asks the planner to dispatch; it never skips the planner session's confirmation unless the user turned on `sessions.mentionReuse`, and the mod adds its note only in a planner session, never in an executor process or to a slash command.
- Start every child process with `windowsHide` on Windows: a worker has no console, and a child that gets a console of its own can be killed with it.
- Drive the codexhost executor only through the documented `codexhost` CLI and its JSON fields (threadId, turnId, status, result, pendingQuestions); never edit codex-host's files or settings. Strip `CODEXHOST_RUNTIME_*` and the caller's Thread ids from its environment.
- Treat two codexhost limits as known exceptions: the Host starts the harness, so a codexhost review has no hard read-only sandbox (its changes are all out of scope and cannot be applied), and `AGENTHUB_RELAY_ROLE` does not reach the harness, so a caller whose `CODEXHOST_THREAD_ID` or `CODEX_THREAD_ID` is the Thread of a running or needs-input codexhost job is refused as an executor.
- Keep the Claude Code mod inactive in a codexhost Thread (`CODEXHOST_THREAD_ID` or `CODEX_THREAD_ID`) until `relay_agents` reports the session's role as planner: the claude-code harness loads the user's plugins.
- Record a turn that stopped on an executor's question as `failed` with `error.code` `needs-input`; such a job keeps its scope, an answer interrupts the waiting turn, and discarding or applying it cancels that turn in the Host.
- Start a codexhost job under the request id `agenthub-relay-<jobId>`, so a retried `delegate start` cannot start a second Thread; retry `thread cancel`, and record a turn that may still run in the Host as a warning.
- Tell a planner it will be woken only when something will wake it: the Claude Code mod, or a codexhost Thread the Host can read; any other planner waits with relay_wait. The mod does not wake a job the relay wakes in its codexhost Thread, and the waker reconciles the jobs it waits on, since nothing else will while their planner waits.

## Verification rules

- Record checks with Birdview semantics: `passed` requires exit code 0, `failed` requires a non-zero exit code and `not-run` requires a null exit code; a job with any failed check ends as `failed`, and a job without checks is reported as unverified.
- Ship every behavior change with a `node --test` test that exercises observable behavior through public interfaces; changes to `hooks/` also need `claude plugin test` coverage.

## Cache keep-alive rules

- Keep a planner's prompt cache warm only with a request that resends its own conversation without adding a turn to it (for Claude Code, `$.model.fork`), only while relay jobs are running, never once the cache is presumed cold, and never beyond the configured ceiling.
- Do not keep a planner warm that has no such request: Codex (`exec resume --ephemeral` still writes the turn to the Thread's rollout, measured on 26.1117) and Antigravity are reported unsupported, DeepSeek Harness not needed (its disk cache lasts hours to days); say why in `relay_agents`.
