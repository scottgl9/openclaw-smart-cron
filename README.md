# openclaw-plugin-smart-cron

**Run agents only when conditions are met, or execute scheduled tasks without waking an agent.**

This plugin attaches to OpenClaw's `before_agent_reply` claiming hook and decides
— per scheduled run — whether to:

- **Gate (`mode: "gate"`)**: run a check script first; let the agent run if work
  is found, otherwise swallow the turn before the model is invoked.
- **Task (`mode: "task"`)**: run the script and unconditionally claim the turn.
  The model is never invoked. Use this to drive plain cron-style automation
  through OpenClaw's scheduler without any LLM cost.

The hook fires on both `cron`-triggered and `heartbeat`-triggered runs. See
[OpenClaw issue #49339](https://github.com/openclaw/openclaw/issues/49339#issuecomment-4318029106)
for the design rationale (this plugin is the recommended user-space implementation).

## Status

Working. Covers both gate and task modes, concurrency-safe, validates rules at
register time.

## Modes

### `mode: "gate"` (default)

The check script's exit code drives the decision:

- exit `0` → continue to the agent (work found).
- exit `10` by default → swallow this run (no work).
- `skipExitCodes` lets you change or extend the skip codes; by default it is
  `[10]`.
- any other non-zero → swallow by default. Set `failOpen: true` to continue
  anyway (run the agent on script error).

### `mode: "task"`

Always claims the turn — the agent is never invoked. The script is the work.

- exit `0` → logged as task success.
- exit `10` by default → logged as task skip.
- `skipExitCodes` lets you change or extend the skip codes; by default it is
  `[10]`.
- non-zero → logged as task failure (or task-error-ignored if `failOpen: true`).

In both modes the OpenClaw cron entry must still exist — it's what fires the
hook. For `mode: "task"`, set the cron entry's agent to a cheap/local model
(e.g. `qwen36`); the model is never actually run because the hook claims the turn.

## Rule schema

```ts
type Rule = {
  mode?: "gate" | "task";              // default "gate"
  match?: {
    trigger?: "cron" | "heartbeat";
    agentId?: string;
    sessionKey?: string;
    channelId?: string;
    runId?: string;
  };
  file: string;                         // absolute path; ~ is expanded
  args?: string[];
  cwd?: string;                         // working dir for the script
  env?: Record<string, string>;         // merged onto inherited process.env
  timeoutSeconds?: number;              // 1..300, default 30
  skipExitCodes?: number[];             // default [10]
  failOpen?: boolean;                   // default false
  logOutput?: boolean;                  // log truncated stdout/stderr
};
```

Rules are evaluated **first-match-wins**.

## Config example

Add the following example to your main OpenClaw config file at
`~/.openclaw/openclaw.json` (merge it into the existing top-level object; do
not save it as a standalone file inside this plugin repo):

```json5
{
  plugins: {
    load: {
      paths: ["/path/to/openclaw-plugin-smart-cron"]
    },
    // Ensure the plugin is allowed in your OpenClaw config if your instance
    // restricts plugin loading.
    allow: ["smart-cron"],
    entries: {
      "smart-cron": {
        enabled: true,
        config: {
          rules: [
            // Recommended pattern for native OpenClaw cron jobs:
            // match a specific cron job by runId so the gate applies only to
            // that one scheduled workflow.
            {
              mode: "gate",
              match: {
                trigger: "cron",
                runId: "11111111-2222-3333-4444-555555555555"
              },
              file: "~/scripts/pr-check.sh",
              timeoutSeconds: 180,
              skipExitCodes: [10],
              logOutput: true
            },

            // Another cron gate, also matched by runId.
            {
              mode: "gate",
              match: {
                trigger: "cron",
                runId: "66666666-7777-8888-9999-000000000000"
              },
              file: "~/scripts/jira-check.sh",
              timeoutSeconds: 180,
              skipExitCodes: [10],
              logOutput: true
            },

            // Heartbeat gating can still match on agentId when that is the
            // clearest stable selector for the workflow.
            {
              mode: "gate",
              match: { trigger: "heartbeat", agentId: "sentinel-personal" },
              file: "~/scripts/email-check.sh",
              failOpen: false
            },

            // Task mode example: run a script as the entire job without ever
            // invoking the agent/model.
            {
              mode: "task",
              match: { trigger: "cron", agentId: "scheduled-tasks" },
              file: "~/scripts/nightly-archive.sh",
              env: { ARCHIVE_DEST: "~/archives/nightly" },
              cwd: "~/scripts",
              timeoutSeconds: 300,
              logOutput: true
            }
          ]
        }
      }
    }
  }
}
```

For native OpenClaw cron jobs, `runId` is often the best matcher because it
pins the rule to one exact scheduled job, even if multiple jobs target the same
agent.


All paths and agent IDs above are illustrative placeholders; replace them with
real values from your own OpenClaw instance.


## Conventions for check scripts

- **Exit `0`** → work found, run the agent.
- **Exit `10`** → no work, skip cleanly (default skip code).
- **`skipExitCodes`** → change or extend the skip codes if you want to use a
  different convention; default is `[10]`.
- **Exit anything else** → unexpected error. Plugin swallows the turn unless
  `failOpen: true`.
- Keep checks fast. The hook runs inline before the agent — long checks delay
  the model. Default timeout is 30s, max 300s.
- Write to stderr/stdout; with `logOutput: true` the plugin captures (truncated
  to 4 KiB) into the OpenClaw log.

## Behavior details

- **Concurrency**: each rule has an in-flight guard. If a second invocation
  arrives while the first is still running for that rule, it's logged and
  returned as `smart-cron-busy` — the second turn is swallowed cleanly,
  no double-execution.
- **Path expansion**: `~/...` is expanded to the user's home directory.
  Relative paths are resolved against the plugin's `rootDir` (provided by
  the host) or the current working directory. Absolute paths recommended.
- **Environment**: scripts inherit the OpenClaw runtime's `process.env`. Any
  `env` keys on the rule override entries with the same name.
- **Validation**: at plugin register time, missing/non-executable files,
  empty `match` blocks, and `failOpen + mode: task` combos are warned about
  in the log (not fatal).
- **Logging**: each handled run emits a structured line of the form
  `smart-cron rule=<idx> trigger=<...> agent=<...> mode=<...> exit=<n> durationMs=<ms> <verdict>`.

## Local development

```bash
npm install
npm test
```

Tests run against the pure runtime in `src/runtime.ts` via the `tsx` loader —
no OpenClaw harness is needed for unit tests.

## Verifying against a live OpenClaw

```bash
openclaw plugins install --link /path/to/openclaw-plugin-smart-cron
openclaw plugins doctor
openclaw plugins list | grep smart-cron   # should show "loaded"
```

Then add the plugin's entry to `~/.openclaw/openclaw.json` (`plugins.allow`,
`plugins.load.paths`, and `plugins.entries["smart-cron"]`) and trigger one
of the matching cron or heartbeat runs using your normal OpenClaw scheduler or
control surface. Then inspect the cron log for `smart-cron` lines:

```bash
tail ~/.openclaw/logs/cron/cron.log
```

## Notes

- Scripts are spawned via `execFile`, not a shell — no shell injection.
- `stdout` / `stderr` are captured with a 64 KiB buffer cap and truncated to
  4 KiB when logged.
- The plugin uses public OpenClaw SDK subpath imports only
  (`openclaw/plugin-sdk/plugin-entry`).
