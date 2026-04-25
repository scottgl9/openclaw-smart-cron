# Changelog

## 0.1.0 — Unreleased

- Initial public scaffold of `smart-scheduler` plugin.
- `before_agent_reply` claiming hook for `cron` and `heartbeat` triggers.
- Two modes:
  - `gate`: run a check script first; continue to the agent on exit `0`,
    swallow on exit `10` (or any code in `skipExitCodes`).
  - `task`: always claim the turn; run the script with no model invocation.
- Per-rule `cwd`, `env`, `args`, `timeoutSeconds`, `failOpen`, `logOutput`.
- Match by `trigger`, `agentId`, `sessionKey`, `channelId`, `runId`.
- Concurrency guard (per-rule in-flight Promise map).
- Register-time validation: warns on missing/non-executable files, empty
  match blocks, and `failOpen + mode: task` combos.
- `~/` path expansion and `host.resolvePath` integration.
