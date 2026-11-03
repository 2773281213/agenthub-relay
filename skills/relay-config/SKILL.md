---
name: relay-config
description: Show or change which agent and model each agenthub-relay tier uses in this planner session, and the roles saved for later sessions. Use only when the user invokes relay-config.
disable-model-invocation: true
---

# relay-config: who executes, with which model

This thin entry uses the agenthub-relay skill in the sibling `../agenthub-relay` directory; run its script as `node ../agenthub-relay/scripts/cli.mjs`.

1. Run `session start --planner <you>` and explain it plainly: who is taken to be planning and who planned last, and for each tier (deep, light, review) the executor, model and effort, where each comes from, and the check of each model. Mention executors that are not installed and agents whose model list could not be read. `models <agent>` lists what an agent offers.
2. Ask the user whether to keep these roles or change them, and wait for the answer.
3. Say exactly what you will confirm, then run `session confirm <id> --reuse`, or `session confirm <id>` with `--deep`, `--light` or `--review` set to `executor[:model][@effort]` (add `--user` when the user wants the change for every project). If a check fails, nothing is saved: show the reason and the suggested names and ask again. Use the session id on later dispatches.

`config show` lists every setting and where it comes from; `config set <key> <value>` and `config unset <key>` change single settings (tier values are checked the same way), for example `sessions.required` or an executor's `timeoutMinutes`.

DeepSeek Harness uses its own settings: the relay shows its default model and refuses a model for it. Credentials (`passEnv`) are not settable here; they are edited by hand and hold variable names only. This skill never changes any agent's own settings, the planner's model included; in Claude Code that is `/model`.
