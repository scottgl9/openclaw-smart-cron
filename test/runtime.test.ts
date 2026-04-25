import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBeforeAgentReplyHandler,
  validateRules,
  type HostBindings,
  type PluginConfig,
  type Logger,
} from "../src/runtime.js";

type LogCapture = {
  logger: Logger;
  info: string[];
  warn: string[];
  error: string[];
};

function makeLogger(): LogCapture {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      info: (m) => info.push(m),
      warn: (m) => warn.push(m),
      error: (m) => error.push(m),
    },
  };
}

function makeHost(pluginConfig: PluginConfig, capture = makeLogger()): HostBindings & { capture: LogCapture } {
  return {
    logger: capture.logger,
    pluginConfig,
    capture,
  };
}

let scratchDir: string;
let pendingDirs: string[] = [];

async function ensureScratch(): Promise<string> {
  if (!scratchDir) {
    scratchDir = await mkdtemp(join(tmpdir(), "smart-scheduler-test-"));
    pendingDirs.push(scratchDir);
  }
  return scratchDir;
}

async function writeScript(name: string, body: string): Promise<string> {
  const dir = await ensureScratch();
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
  return path;
}

test.after(async () => {
  for (const d of pendingDirs) await rm(d, { recursive: true, force: true });
});

test("declines non-cron/non-heartbeat triggers", async () => {
  const host = makeHost({ rules: [] });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "user" });
  assert.equal(result, undefined);
});

test("declines when no rule matches", async () => {
  const trueScript = await writeScript("true.sh", "#!/bin/sh\nexit 0\n");
  const host = makeHost({
    rules: [{ match: { trigger: "heartbeat", agentId: "a" }, file: trueScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "heartbeat", agentId: "b" });
  assert.equal(result, undefined);
});

test("matches by channelId and runId", async () => {
  const trueScript = await writeScript("true2.sh", "#!/bin/sh\nexit 0\n");
  const host = makeHost({
    rules: [
      { match: { trigger: "cron", channelId: "ch1", runId: "r1" }, file: trueScript },
    ],
  });
  const handler = createBeforeAgentReplyHandler(host);
  assert.equal(
    await handler({ cleanedBody: "x" }, { trigger: "cron", channelId: "ch1", runId: "r1" }),
    undefined,
  );
  assert.deepEqual(
    await handler({ cleanedBody: "x" }, { trigger: "cron", channelId: "ch2", runId: "r1" }),
    undefined,
  );
});

test("gate mode returns handled skip on exit 10", async () => {
  const skipScript = await writeScript("skip.sh", "#!/bin/sh\nexit 10\n");
  const host = makeHost({
    rules: [{ match: { trigger: "heartbeat" }, file: skipScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "heartbeat" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-skip" });
});

test("gate mode continues on exit 0", async () => {
  const okScript = await writeScript("ok.sh", "#!/bin/sh\nexit 0\n");
  const host = makeHost({
    rules: [{ match: { trigger: "cron" }, file: okScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.equal(result, undefined);
});

test("gate mode swallows errors by default", async () => {
  const failScript = await writeScript("fail.sh", "#!/bin/sh\nexit 2\n");
  const host = makeHost({
    rules: [{ match: { trigger: "cron" }, file: failScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-error" });
});

test("gate mode continues on errors when failOpen=true", async () => {
  const failScript = await writeScript("fail2.sh", "#!/bin/sh\nexit 2\n");
  const host = makeHost({
    rules: [{ match: { trigger: "cron" }, file: failScript, failOpen: true }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.equal(result, undefined);
});

test("task mode handles success without waking agent", async () => {
  const okScript = await writeScript("ok2.sh", "#!/bin/sh\nexit 0\n");
  const host = makeHost({
    rules: [{ mode: "task", match: { trigger: "cron" }, file: okScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-task-complete" });
});

test("task mode handles skip exit", async () => {
  const skipScript = await writeScript("skip2.sh", "#!/bin/sh\nexit 10\n");
  const host = makeHost({
    rules: [{ mode: "task", match: { trigger: "heartbeat" }, file: skipScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "heartbeat" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-task-skip" });
});

test("task mode swallows failures by default", async () => {
  const failScript = await writeScript("fail3.sh", "#!/bin/sh\nexit 2\n");
  const host = makeHost({
    rules: [{ mode: "task", match: { trigger: "cron" }, file: failScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-task-error" });
});

test("task mode marks ignored when failOpen=true", async () => {
  const failScript = await writeScript("fail4.sh", "#!/bin/sh\nexit 2\n");
  const host = makeHost({
    rules: [{ mode: "task", match: { trigger: "cron" }, file: failScript, failOpen: true }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-task-error-ignored" });
});

test("reads from pluginConfig (regression: was reading api.config)", async () => {
  const okScript = await writeScript("plugin-cfg.sh", "#!/bin/sh\nexit 0\n");
  const capture = makeLogger();
  // Wrong shape (rules under "config" key): should NOT match.
  const wrongHost: HostBindings = {
    logger: capture.logger,
    pluginConfig: { config: { rules: [{ match: { trigger: "cron" }, file: okScript }] } } as any,
  };
  const wrongHandler = createBeforeAgentReplyHandler(wrongHost);
  assert.equal(await wrongHandler({ cleanedBody: "x" }, { trigger: "cron" }), undefined);

  // Correct shape (rules at root): should match.
  const rightHost: HostBindings = {
    logger: capture.logger,
    pluginConfig: { rules: [{ match: { trigger: "cron" }, file: okScript }] },
  };
  const rightHandler = createBeforeAgentReplyHandler(rightHost);
  assert.equal(await rightHandler({ cleanedBody: "x" }, { trigger: "cron" }), undefined);
});

test("passes args, cwd, and env to the script", async () => {
  const dir = await ensureScratch();
  const script = await writeScript(
    "echo-env.sh",
    "#!/bin/sh\nprintf '%s|%s|%s' \"$1\" \"$SS_TEST_VAR\" \"$PWD\" >&2\nexit 10\n",
  );
  const capture = makeLogger();
  const host: HostBindings = {
    logger: capture.logger,
    pluginConfig: {
      rules: [
        {
          match: { trigger: "cron" },
          file: script,
          args: ["hello"],
          env: { SS_TEST_VAR: "from-rule" },
          cwd: dir,
          logOutput: true,
        },
      ],
    },
  };
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(result, { handled: true, reason: "smart-scheduler-skip" });
  const stderrLine = capture.info.find((m) => m.includes("stderr="));
  assert.ok(stderrLine, "expected logOutput info line");
  assert.match(stderrLine!, /hello\|from-rule\|/);
  assert.ok(stderrLine!.includes(dir));
});

test("concurrency guard returns busy on overlap", async () => {
  const slowScript = await writeScript("slow.sh", "#!/bin/sh\nsleep 0.3\nexit 0\n");
  const host = makeHost({
    rules: [{ match: { trigger: "cron" }, file: slowScript }],
  });
  const handler = createBeforeAgentReplyHandler(host);
  const a = handler({ cleanedBody: "x" }, { trigger: "cron" });
  // schedule second call shortly after, while first is still running
  await new Promise((r) => setTimeout(r, 30));
  const b = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.deepEqual(b, { handled: true, reason: "smart-scheduler-busy" });
  assert.equal(await a, undefined);
});

test("validateRules warns about missing files and empty matchers", async () => {
  const capture = makeLogger();
  const host: HostBindings = {
    logger: capture.logger,
    pluginConfig: {
      rules: [
        { file: "/nonexistent/path/script.sh" },
        { match: { trigger: "cron" }, mode: "task", file: "/nonexistent/2.sh", failOpen: true },
      ],
    },
  };
  await validateRules(host);
  assert.ok(capture.warn.some((m) => m.includes("file not executable or missing")));
  assert.ok(capture.warn.some((m) => m.includes("no match criteria")));
  assert.ok(capture.warn.some((m) => m.includes("failOpen=true with mode=task")));
});

test("expands ~ paths via host.resolvePath when provided", async () => {
  const okScript = await writeScript("home-resolve.sh", "#!/bin/sh\nexit 0\n");
  const capture = makeLogger();
  let seen: string | undefined;
  const host: HostBindings = {
    logger: capture.logger,
    pluginConfig: { rules: [{ match: { trigger: "cron" }, file: "~/whatever" }] },
    resolvePath: (input) => {
      seen = input;
      return okScript;
    },
  };
  const handler = createBeforeAgentReplyHandler(host);
  const result = await handler({ cleanedBody: "x" }, { trigger: "cron" });
  assert.equal(result, undefined);
  assert.ok(seen && !seen.startsWith("~/"), "expected ~ to be expanded before host.resolvePath");
});
