# Changelog

## 0.9.0

- Added `jobId` matcher support for cron-targeted rules, aligned with merged OpenClaw PR #71827.
- Updated docs to recommend `jobId` for stable cron job targeting while noting that live use must wait for an OpenClaw version containing that change.
- Polished README and publication metadata for ClawHub/npm-style distribution.
- Added author, repository, homepage, bugs, and publish file metadata.

## 0.1.0

- Initial public scaffold of `smart-cron` plugin.
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
