@AGENTS.md

## Claude Code notes

- The mod in `hooks/register.ts` targets Claude Code 2.1.287 or later and is type-checked against the 2.1.311 mod types. Validate it with `claude plugin validate .` and test it with `claude plugin test .`.
- When Claude Code is the planner, end the turn after dispatching jobs; the mod keeps the cache warm while jobs run and wakes the session when a job finishes.
