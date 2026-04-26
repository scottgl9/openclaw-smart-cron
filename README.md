# Smart Cron for OpenClaw

**Run scheduled workflows only when conditions are met — or execute cron-driven tasks without waking the model.**

Smart Cron is an OpenClaw plugin for **gating** scheduled runs and **executing script-only jobs** through OpenClaw's scheduler.
It attaches to OpenClaw's `before_agent_reply` claiming hook and decides, per run, whether to:

- **Gate (`mode: "gate"`)** — run a check script first; continue to the agent only when real work exists.
- **Task (`mode: "task"`)** — run the script as the job itself and always claim the turn, so the model never runs.

This is useful when you want OpenClaw cron jobs to behave more like production automation: **cheap when idle, selective when work exists, and script-first when no LLM is needed**.

[OpenClaw](https://github.com/openclaw/openclaw) · [Docs](https://docs.openclaw.ai) · [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs) · [Skills](https://docs.openclaw.ai/tools/skills) · [ClawHub](https://clawhub.ai)

> Smart Cron is ideal for PR checks, inbox triage, Jira polling, watchdog workflows, and any scheduled automation that should stay quiet when there is no real work.

## Why Smart Cron?

Native OpenClaw cron jobs are great at scheduling. Smart Cron adds a thin decision layer before the model runs.

Use it when you want to:

- skip scheduled runs cleanly when there is no work
- run shell scripts on a schedule without any model cost
- gate expensive PR, Jira, inbox, or monitoring workflows
- avoid duplicate fetches by handing artifacts from a gate script to the downstream prompt
- keep scheduling in OpenClaw while moving decision logic into small, testable scripts

The hook fires on both `cron`-triggered and `heartbeat`-triggered runs. See
[OpenClaw issue #49339](https://github.com/openclaw/openclaw/issues/49339#issuecomment-4318029106)
for the design rationale behind this plugin approach.

## Highlights

- **Two modes**: `gate` and `task`
- **First-match-wins rules** for precise workflow targeting
- **Cron and heartbeat triggers**
- **Per-rule args, env, cwd, timeouts, and skip exit codes**
- **Concurrency-safe** with an in-flight guard per rule
- **Publishable plugin shape** with bundled skill support
- **Lightweight local development** with pure runtime unit tests

## Status

Working and test-covered. The current plugin supports:

- gate mode
- task mode
- rule validation at register time
- structured logging
- `~/` expansion and host path resolution
- `jobId` matching support for newer OpenClaw builds

## At a glance

| Capability | Supported |
| --- | --- |
| `cron` trigger | Yes |
| `heartbeat` trigger | Yes |
| Gate mode | Yes |
| Task mode | Yes |
| Rule matching by `agentId` / `channelId` / `sessionKey` | Yes |
| Rule matching by `runId` | Yes |
| Rule matching by `jobId` | Yes, on newer OpenClaw builds |
| Bundled skill | Yes |
| Unit tests | Yes |

## Quick start

### 1) Install or link the plugin

```bash
openclaw plugins install --link /path/to/openclaw-plugin-smart-cron
openclaw plugins doctor
openclaw plugins list | grep smart-cron
```

### 2) Add it to your OpenClaw config

Add a `smart-cron` entry to `~/.openclaw/openclaw.json` under:

- `plugins.load.paths`
- `plugins.allow`
- `plugins.entries["smart-cron"]`

A full example is shown below.

### 3) Trigger a matching cron or heartbeat run

Then inspect logs for `smart-cron` lines:

```bash
tail ~/.openclaw/logs/cron/cron.log
```

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
    jobId?: string;
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

## Configuration example

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
            // match a specific cron job by jobId so the gate applies only to
            // that one scheduled workflow.
            {
              mode: "gate",
              match: {
                trigger: "cron",
                jobId: "11111111-2222-3333-4444-555555555555"
              },
              file: "~/scripts/pr-check.sh",
              timeoutSeconds: 180,
              skipExitCodes: [10],
              logOutput: true
            },

            // Another cron gate, also matched by jobId.
            {
              mode: "gate",
              match: {
                trigger: "cron",
                jobId: "66666666-7777-8888-9999-000000000000"
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

For native OpenClaw cron jobs, `jobId` is now the best matcher because it pins
the rule to one exact scheduled job. `runId` is still available, but it refers
to the individual execution instance rather than the stable cron job identity.

All paths and agent IDs above are illustrative placeholders; replace them with
real values from your own OpenClaw instance.

## Matching guidance

Supported match keys:

- `trigger`
- `agentId`
- `sessionKey`
- `channelId`
- `runId`
- `jobId`

Recommended matching strategy:

- use **`jobId`** for stable native cron-job targeting once your OpenClaw install includes merged PR [#71827](https://github.com/openclaw/openclaw/pull/71827)
- use **`runId`** only when you intentionally want to target one execution instance or while waiting on that OpenClaw upgrade
- use **`agentId`** or **`channelId`** when the workflow is broader than a single cron job
- keep rules specific, because evaluation is **first-match-wins**

## Check script conventions

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

## Typical use cases

### Gate a PR review workflow

Run a lightweight script first. If no PRs need attention, exit `10` and skip the model entirely.

### Gate Jira or inbox triage

Use a fast polling script to decide whether the downstream agent prompt should run.

### Run script-only scheduled jobs

Use `mode: "task"` when the script itself is the whole job and no LLM wake is needed.

### Share expensive fetches with downstream prompts

If the gate script already fetched useful data, write a handoff artifact (for example under `/tmp`) so the downstream prompt can reuse it.

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

## Publishing notes

If you plan to publish this plugin on ClawHub:

- keep `README.md`, `openclaw.plugin.json`, `package.json`, and the bundled skill aligned
- prefer stable public SDK imports only
- document any OpenClaw version dependency clearly
- keep examples realistic, but mark placeholders as placeholders
- verify install, doctor, and runtime behavior from a clean OpenClaw instance before publishing
- use a concise plugin description and strong keywords so the listing is discoverable

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
- `jobId` matching requires an OpenClaw version that includes merged PR
  [#71827](https://github.com/openclaw/openclaw/pull/71827). Until you upgrade
  to a build containing that change, keep using `runId`/other matchers in live
  config.
