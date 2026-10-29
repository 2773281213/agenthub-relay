---
name: relay-config
description: Show or change which agent and model each agenthub-relay tier uses, and which profile each planner gets. Use only when the user invokes relay-config.
disable-model-invocation: true
---

# relay-config: who executes, with which model

This thin entry uses the agenthub-relay skill in the sibling `../agenthub-relay` directory; run its script as `node ../agenthub-relay/scripts/cli.mjs`.

1. Run `config show --planner <you>` and explain it plainly: who is taken to be planning, the active profile and why, and for each tier (deep, light, review) the executor, model and effort. Mention executors that are not installed.
2. Turn what the user wants into settings:
   - a tier: `profiles.<profile>.<tier>` with a value `executor[:model][@effort]`, for example `claude:opus@high` or `dsh`;
   - an executor's default model or effort: `executors.<codex|claude|dsh>.model` or `.effort`;
   - which profile a planner gets: `plannerProfiles.<claude|codex|dsh|agy>`; the default profile: `profile`.
   Use `--user` when the user wants the setting for every project; otherwise it is saved in this repository's `.agenthub/config.json`.
3. Say exactly what you will write and where, and wait for the user to agree. Then run `config set <key> <value>` (or `config unset <key>`) and show `config show` again.

DeepSeek Harness has no documented flag for choosing a model: the relay refuses a model for it, and its model is set in DeepSeek Harness's own settings. Credentials (`passEnv`) are not settable here; they are edited by hand and hold variable names only. This skill cannot change the planner's own model; in Claude Code that is `/model`.
