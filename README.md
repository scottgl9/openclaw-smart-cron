# openclaw-plugin-smart-scheduler

**Run agents only when conditions are met, or execute scheduled tasks without waking an agent.**

## Status
Initial working scaffold.

Current implementation focuses on conditional gating for `cron` and `heartbeat` runs using the real `before_agent_reply` claiming hook.

## Current behavior
For matching `cron` or `heartbeat` turns:
- exit `0` => continue normally to the agent
- exit `10` => skip/swallow the turn
- other non-zero => swallow the turn by default
- `failOpen: true` => continue even when the script errors

## Why this plugin exists
Many scheduled automations do not need to wake an agent every time, and some should never wake an agent at all.

Examples:
- only run an agent if new email exists
- only run an agent if a watched file changed
- skip a heartbeat when nothing meaningful happened
- run a scheduled task directly without invoking an agent at all

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
              match: {
                trigger: "heartbeat",
                agentId: "sentinel-agent"
              },
              file: "<script-path>",
              args: ["--fast"],
              timeoutSeconds: 30,
              skipExitCodes: [10],
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
Current scaffold supports:
- `match.trigger`
- `match.agentId`
- `match.sessionKey`
- `match.reasonIncludes`

## Notes
- Scripts are run with `execFile`, not a shell command string.
- Output logging is truncated.
- The current scaffold uses first-match-wins across rules.
- Planned expansion: support direct scheduled task handling mode in addition to gate/skip behavior.
