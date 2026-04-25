import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
} from "openclaw/plugin-sdk/src/plugins/hooks";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_SKIP_EXIT_CODES = new Set([10]);
const MAX_BUFFER = 64 * 1024;
const LOG_OUTPUT_MAX_CHARS = 4096;

type Trigger = "cron" | "heartbeat";

type MatchRule = {
  trigger?: Trigger;
  agentId?: string;
  sessionKey?: string;
  reasonIncludes?: string;
};

type Rule = {
  match?: MatchRule;
  file: string;
  args?: string[];
  timeoutSeconds?: number;
  skipExitCodes?: number[];
  failOpen?: boolean;
  logOutput?: boolean;
};

type PluginConfig = {
  rules?: Rule[];
};

type ExecOutcome = {
  kind: "continue" | "skip" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
};

function clampTimeout(timeoutSeconds?: number): number {
  if (!Number.isFinite(timeoutSeconds)) return DEFAULT_TIMEOUT_MS;
  const ms = Math.trunc((timeoutSeconds ?? 30) * 1000);
  return Math.max(1000, Math.min(ms, MAX_TIMEOUT_MS));
}

function truncateForLog(value: string): string {
  if (!value) return "";
  return value.length > LOG_OUTPUT_MAX_CHARS ? `${value.slice(0, LOG_OUTPUT_MAX_CHARS)}…` : value;
}

function normalizeOutput(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function matchesRule(rule: Rule, ctx: PluginHookAgentContext & { reason?: string }): boolean {
  const match = rule.match;
  if (!match) return true;
  if (match.trigger && ctx.trigger !== match.trigger) return false;
  if (match.agentId && ctx.agentId !== match.agentId) return false;
  if (match.sessionKey && ctx.sessionKey !== match.sessionKey) return false;
  if (match.reasonIncludes && !(ctx.reason ?? "").includes(match.reasonIncludes)) return false;
  return true;
}

async function runRule(rule: Rule): Promise<ExecOutcome> {
  const timeout = clampTimeout(rule.timeoutSeconds);
  const skipExitCodes = new Set(rule.skipExitCodes?.length ? rule.skipExitCodes : Array.from(DEFAULT_SKIP_EXIT_CODES));

  try {
    const result = await execFileAsync(rule.file, rule.args ?? [], {
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    return {
      kind: "continue",
      exitCode: 0,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
    };
  } catch (error: any) {
    const code = typeof error?.code === "number" ? error.code : null;
    const stdout = normalizeOutput(error?.stdout);
    const stderr = normalizeOutput(error?.stderr);

    if (code !== null && skipExitCodes.has(code)) {
      return {
        kind: "skip",
        exitCode: code,
        stdout,
        stderr,
      };
    }

    return {
      kind: "error",
      exitCode: code,
      stdout,
      stderr,
      error,
    };
  }
}

function createBeforeAgentReplyHandler(api: OpenClawPluginApi) {
  return async (
    _event: PluginHookBeforeAgentReplyEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentReplyResult | void> => {
    if (ctx.trigger !== "cron" && ctx.trigger !== "heartbeat") return;

    const config = (api.config ?? {}) as PluginConfig;
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const rule = rules.find((candidate) => matchesRule(candidate, ctx));
    if (!rule) return;

    const outcome = await runRule(rule);
    const prefix = `prehook-gate: ${ctx.trigger}${ctx.agentId ? ` agent=${ctx.agentId}` : ""}`;

    if (rule.logOutput && (outcome.stdout || outcome.stderr)) {
      api.logger.info(
        `${prefix} stdout=${JSON.stringify(truncateForLog(outcome.stdout))} stderr=${JSON.stringify(truncateForLog(outcome.stderr))}`,
      );
    }

    if (outcome.kind === "continue") {
      api.logger.info(`${prefix} continuing (exit=${outcome.exitCode ?? "0"})`);
      return;
    }

    if (outcome.kind === "skip") {
      api.logger.info(`${prefix} skipped by rule ${rule.file} (exit=${outcome.exitCode ?? "unknown"})`);
      return {
        handled: true,
        reason: "smart-scheduler-skip",
      };
    }

    if (rule.failOpen) {
      api.logger.warn(`${prefix} prehook error but failOpen=true; continuing. ${String(outcome.error)}`);
      return;
    }

    api.logger.error(`${prefix} prehook failed; swallowing run. ${String(outcome.error)}`);
    return {
      handled: true,
      reason: "smart-scheduler-error",
    };
  };
}

export { createBeforeAgentReplyHandler };

export default definePluginEntry({
  id: "prehook-gate",
  name: "PreHook Gate",
  description: "Run agents only when conditions are met, or execute scheduled tasks without waking an agent.",
  register(api) {
    api.on("before_agent_reply", createBeforeAgentReplyHandler(api));
  },
});
