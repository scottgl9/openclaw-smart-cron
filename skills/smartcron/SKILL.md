---
name: smartcron
description: Use the Smartcron plugin to gate scheduled OpenClaw runs or execute scheduled tasks without waking the model.
---

Use this skill when configuring or reviewing OpenClaw scheduled workflows that should only wake an agent when real work exists, or when a cron-driven job should run a script without invoking the model.

## What this plugin does

Smartcron attaches to OpenClaw's `before_agent_reply` hook and evaluates matching rules before the model runs.

It supports two modes:

- `mode: "gate"` — run a script first; continue to the agent only when the script indicates work exists.
- `mode: "task"` — run a script as the job itself and always claim the turn so the model never runs.

## Recommended usage

Prefer native OpenClaw cron jobs as the scheduler and use Smartcron only for the decision layer.

Recommended pattern:

1. Keep the real OpenClaw cron job.
2. Match the Smartcron rule by `jobId` when targeting one exact cron workflow (once the OpenClaw instance has upgraded to a build that includes merged PR #71827).
3. Use `mode: "gate"` when the downstream agent prompt should run only if real work exists.
4. Use `mode: "task"` only when the script itself is the whole job and no agent/model wake is needed.
5. If the gate script performs an expensive fetch that the downstream agent also needs, write a handoff artifact (for example in `/tmp`) so the prompt can reuse it instead of repeating the fetch.

## Exit code conventions

Default conventions:

- exit `0` = work found / continue
- exit `10` = no work / skip
- `skipExitCodes` defaults to `[10]` and is configurable
- other non-zero exit codes are treated as errors

In `mode: "gate"`:

- exit `0` allows the agent run to continue
- configured skip exit codes swallow the turn before model invocation
- other failures also swallow by default unless `failOpen: true`

In `mode: "task"`:

- the turn is always claimed
- the model is never invoked
- the script outcome is logged as success, skip, or failure

## Matching guidance

Supported match keys:

- `trigger`
- `agentId`
- `sessionKey`
- `channelId`
- `runId`
- `jobId`

Prefer `jobId` for native cron workflows because it pins the rule to one exact scheduled job, even when several jobs target the same agent. Use `runId` only when you intentionally want to target one execution instance or until your OpenClaw instance has upgraded to a build that includes merged PR #71827.

## Configuration guidance

Rules are first-match-wins. Keep them specific.

Example shape:

```json5
{
  plugins: {
    entries: {
      "smartcron": {
        enabled: true,
        config: {
          rules: [
            {
              mode: "gate",
              match: {
                trigger: "cron",
                jobId: "11111111-2222-3333-4444-555555555555"
              },
              file: "~/scripts/check-prs.sh",
              timeoutSeconds: 180,
              skipExitCodes: [10],
              logOutput: true
            }
          ]
        }
      }
    }
  }
}
```

## Good migration patterns

Good fit for Smartcron:

- wrapper-style cron jobs that only decide whether an agent should wake
- PR, Jira, inbox, or mention checks that frequently find no work
- scheduled scripts that should run under OpenClaw scheduling without any LLM cost

Less ideal fit:

- workflows where the native cron prompt already performs the full useful work itself
- cases where a second decision layer only adds duplication or confusion

## Practical rules

- Keep check scripts fast and deterministic.
- Prefer absolute paths or carefully managed `cwd`.
- Use `logOutput: true` when debugging, then keep it only where useful.
- Treat `failOpen: true` as an explicit reliability tradeoff; use it only when missing a run would be worse than a noisy wake.
- Keep the skill and plugin documentation aligned with the actual manifest, schema, and runtime behavior.
