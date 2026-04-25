# openclaw-plugin-smart-scheduler

**Run agents only when conditions are met, or execute scheduled tasks without waking an agent.**

## Status
Initial working scaffold.

Current implementation supports both conditional gating and direct scheduled task handling for `cron` and `heartbeat` runs using the real `before_agent_reply` claiming hook.

## Current behavior
For matching `cron` or `heartbeat` turns, each rule can operate in one of two modes:

### `mode: "gate"` (default)
- exit `0` => continue normally to the agent
- exit `10` => skip/swallow the turn
- other non-zero => swallow the turn by default
- `failOpen: true` => continue even when the script errors

### `mode: "task"`
- run the configured script
- always swallow the scheduled turn so the agent is never invoked
- exit `0` => handled task success
- exit `10` => handled task skip
- other non-zero => handled task failure
- `failOpen: true` => still swallow, but mark the error as ignored

## Why this plugin exists
Many scheduled automations do not need to wake an agent every time, and some should never wake an agent at all.

Examples:
- only run an agent if new email exists
- only run an agent if a watched file changed
- skip a heartbeat when nothing meaningful happened
- run a scheduled task directly without invoking an agent at all
- use OpenClaw scheduling as a lightweight automation layer for scripts

## Config example
```json5
{
  plugins: {
    load: {
      paths: ["<plugin-directory>"]
    },
    entries: {
      "smart-scheduler": {
        enabled: true,
        config: {
          rules: [
            {
              mode: "gate",
              match: {
                trigger: "heartbeat",
                agentId: "sentinel-agent"
              },
              file: "~/bin/check-inbox",
              args: ["--fast"],
              timeoutSeconds: 30,
              skipExitCodes: [10],
              failOpen: false,
              logOutput: true
            },
            {
              mode: "task",
              match: {
                trigger: "cron"
              },
              file: "~/bin/nightly-backup",
              timeoutSeconds: 300,
              failOpen: false,
              logOutput: true
            }
          ]
        }
      }
    }
  }
}
```

## Matching fields
Current implementation supports:
- `match.trigger`
- `match.agentId`
- `match.sessionKey`
- `match.reasonIncludes`

## Notes
- Scripts are run with `execFile`, not a shell command string.
- Output logging is truncated.
- The current scaffold uses first-match-wins across rules.
- `mode` defaults to `gate` when omitted.
- Task mode is useful when OpenClaw scheduling should run a script directly without waking an agent.
