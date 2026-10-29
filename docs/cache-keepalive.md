# Prompt-cache keep-alive / 提示缓存保活

The idea from linux.do topic 3028918: while Claude Code waits for other agents, keep its prompt cache alive every 55 minutes. It holds under one condition, and the mod is built around it.

16 楼的思路成立的前提是：Claude Code 主会话用的是 **1 小时**缓存 TTL。

## When it works

Claude Code picks the TTL per request:

| | Subscription, within plan usage | Usage credits, API key or cloud provider |
|---|---|---|
| Main conversation | one hour | five minutes |
| Everything else | five minutes (server-controlled helper requests: one hour) | five minutes |

You can set the main conversation's TTL with the `promptCacheTtl` setting or `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`); `ENABLE_PROMPT_CACHING_1H=1` asks for one hour for both buckets and `FORCE_PROMPT_CACHING_5M=1` forces five minutes. On a five-minute TTL a 55-minute refresh does nothing, so the mod pauses itself after the first refresh that finds the cache cold.

A cache entry's lifetime is measured from the start of the request that writes or reads it, and every read refreshes it at no extra cost. So a request before the hour runs out keeps the whole conversation cached.

## What it costs

Relative to the model's base input price: a one-hour cache write costs 2×, a five-minute write 1.25×, a read 0.1× (0.05× on Claude Opus 5.5 and Sonnet 5.5, 0.025× on Claude Fable 5.1 and Mythos 5.1).

A refresh reads the conversation once; letting it expire means writing it again. At 0.1× per read against 2× per rewrite, about 20 refreshes cost what one rewrite does, about 18 hours of waiting at 55-minute intervals; at 0.05×, about 36 hours. The default ceiling of 8 hours stays well inside that. On a subscription the same arithmetic applies to your usage limits rather than to money.

## What the mod does

Every minute, while you have the plugin enabled and this process is not an executor, it asks the relay for the job list (`relay_status` with `watch: true`) and then refreshes the cache only when all of these hold:

- `keep_alive` is on and keep-alive is not paused;
- at least one relay job is running;
- the session is idle (no turn of the main conversation in progress);
- the last main-conversation request or refresh started at least `interval_minutes` (55) ago, but less than 60 minutes ago, so the cache is presumed warm;
- your last real request was less than `ceiling_hours` (8) ago.

The refresh is `$.model.fork`: one tool-less question over the session's own transcript exactly as the main thread last sent it, same model and system prompt, so the API serves that prefix from the cache. It adds nothing to the transcript. The mod records how many tokens the fork read from the cache and how many it wrote. If it wrote more than it read, the entry had already lapsed: the mod pauses keep-alive and tells you to set the one-hour TTL.

When a job the session watched ends and nobody has read its result, the mod submits one prompt so Claude reviews it (`wake_on_finish`). Only a job seen running is announced, never one that had ended before the session started.

`/relay` shows jobs, the time of the last request and refresh, cache tokens read and written, compactions seen and the last decision. `/relay off` pauses keep-alive for the session, `/relay on` resumes it.

## Idle compaction

Claude Code can compact a long conversation that sits idle on the one-hour TTL shortly before the cache expires; the `idleCompaction` setting turns that off. Whether a fork resets the idle timer that triggers it is not documented, so the mod records every compaction of the main conversation and `/relay` lists them. If you see compactions while jobs run, set `idleCompaction` to `false` for long waits.

## Sources

- [Claude Code: How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching.md)
- [Claude API: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Claude Code: mods](https://code.claude.com/docs/en/plugins/mods/overview.md)
- [robot-council: Keeping an idle session warm](https://github.com/robot-council/cli/wiki/Keeping-an-idle-session-warm)
