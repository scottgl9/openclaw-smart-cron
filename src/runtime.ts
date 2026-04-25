import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants as fsConstants } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_SKIP_EXIT_CODES: readonly number[] = Object.freeze([10]);
const MAX_BUFFER = 64 * 1024;
const LOG_OUTPUT_MAX_CHARS = 4096;

export type Trigger = "cron" | "heartbeat";

export type MatchRule = {
  trigger?: Trigger;
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  runId?: string;
};

export type Rule = {
  mode?: "gate" | "task";
  match?: MatchRule;
  file: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  skipExitCodes?: number[];
  failOpen?: boolean;
  logOutput?: boolean;
};

export type PluginConfig = {
  rules?: Rule[];
};

export type HookContext = {
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  runId?: string;
};

export type HookEvent = {
  cleanedBody?: string;
};

export type HookResult = {
  handled: boolean;
  reply?: unknown;
  reason?: string;
};

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type HostBindings = {
  logger: Logger;
  pluginConfig?: unknown;
  resolvePath?: (input: string) => string;
  rootDir?: string;
};

type ExecOutcome = {
  kind: "continue" | "skip" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: unknown;
};

type RuntimeRule = Rule & { resolvedFile: string };

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

function resolveRuleMode(rule: Rule): "gate" | "task" {
  return rule.mode === "task" ? "task" : "gate";
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}

export function resolveRuleFile(file: string, host: HostBindings): string {
  const expanded = expandHome(file);
  if (host.resolvePath) return host.resolvePath(expanded);
  if (isAbsolute(expanded)) return expanded;
  return host.rootDir ? resolvePath(host.rootDir, expanded) : resolvePath(expanded);
}

function readRules(host: HostBindings): RuntimeRule[] {
  const config = (host.pluginConfig ?? {}) as PluginConfig;
  const rules = Array.isArray(config.rules) ? config.rules : [];
  return rules.map((rule) => ({ ...rule, resolvedFile: resolveRuleFile(rule.file, host) }));
}

function matchesRule(rule: Rule, ctx: HookContext): boolean {
  const match = rule.match;
  if (!match) return true;
  if (match.trigger && ctx.trigger !== match.trigger) return false;
  if (match.agentId && ctx.agentId !== match.agentId) return false;
  if (match.sessionKey && ctx.sessionKey !== match.sessionKey) return false;
  if (match.channelId && ctx.channelId !== match.channelId) return false;
  if (match.runId && ctx.runId !== match.runId) return false;
  return true;
}

async function runRule(rule: RuntimeRule): Promise<ExecOutcome> {
  const timeout = clampTimeout(rule.timeoutSeconds);
  const skipExitCodes = new Set(rule.skipExitCodes?.length ? rule.skipExitCodes : DEFAULT_SKIP_EXIT_CODES);
  const env = rule.env ? { ...process.env, ...rule.env } : process.env;
  const start = Date.now();

  try {
    const result = await execFileAsync(rule.resolvedFile, rule.args ?? [], {
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      cwd: rule.cwd,
      env,
    });
    return {
      kind: "continue",
      exitCode: 0,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
      durationMs: Date.now() - start,
    };
  } catch (error: any) {
    const code = typeof error?.code === "number" ? error.code : null;
    const stdout = normalizeOutput(error?.stdout);
    const stderr = normalizeOutput(error?.stderr);
    const durationMs = Date.now() - start;
    if (code !== null && skipExitCodes.has(code)) {
      return { kind: "skip", exitCode: code, stdout, stderr, durationMs };
    }
    return { kind: "error", exitCode: code, stdout, stderr, durationMs, error };
  }
}

function buildPrefix(
  ctx: HookContext,
  mode: "gate" | "task",
  ruleIdx: number,
  durationMs: number,
  exitCode: number | null,
): string {
  const parts = [`smart-cron`, `rule=${ruleIdx}`, `trigger=${ctx.trigger}`];
  if (ctx.agentId) parts.push(`agent=${ctx.agentId}`);
  parts.push(`mode=${mode}`);
  parts.push(`exit=${exitCode ?? "null"}`);
  parts.push(`durationMs=${durationMs}`);
  return parts.join(" ");
}

export function createBeforeAgentReplyHandler(host: HostBindings) {
  const inFlight = new Map<number, Promise<ExecOutcome>>();
  const logger = host.logger;

  return async (
    _event: HookEvent,
    ctx: HookContext,
  ): Promise<HookResult | void> => {
    if (ctx.trigger !== "cron" && ctx.trigger !== "heartbeat") return;

    const rules = readRules(host);
    const ruleIdx = rules.findIndex((candidate) => matchesRule(candidate, ctx));
    if (ruleIdx < 0) return;
    const rule = rules[ruleIdx];
    const mode = resolveRuleMode(rule);

    const existing = inFlight.get(ruleIdx);
    if (existing) {
      logger.info(`smart-cron rule=${ruleIdx} trigger=${ctx.trigger} mode=${mode} skipped (in flight)`);
      return { handled: true, reason: "smart-cron-busy" };
    }

    const work = runRule(rule);
    inFlight.set(ruleIdx, work);
    let outcome: ExecOutcome;
    try {
      outcome = await work;
    } finally {
      inFlight.delete(ruleIdx);
    }

    const prefix = buildPrefix(ctx, mode, ruleIdx, outcome.durationMs, outcome.exitCode);

    if (rule.logOutput && (outcome.stdout || outcome.stderr)) {
      logger.info(
        `${prefix} stdout=${JSON.stringify(truncateForLog(outcome.stdout))} stderr=${JSON.stringify(truncateForLog(outcome.stderr))}`,
      );
    }

    if (mode === "task") {
      if (outcome.kind === "continue") {
        logger.info(`${prefix} task completed`);
        return { handled: true, reason: "smart-cron-task-complete" };
      }
      if (outcome.kind === "skip") {
        logger.info(`${prefix} task skipped`);
        return { handled: true, reason: "smart-cron-task-skip" };
      }
      if (rule.failOpen) {
        logger.warn(`${prefix} task error but failOpen=true; swallowing scheduled turn. ${String(outcome.error)}`);
        return { handled: true, reason: "smart-cron-task-error-ignored" };
      }
      logger.error(`${prefix} task failed; swallowing scheduled turn. ${String(outcome.error)}`);
      return { handled: true, reason: "smart-cron-task-error" };
    }

    if (outcome.kind === "continue") {
      logger.info(`${prefix} continuing to agent`);
      return;
    }
    if (outcome.kind === "skip") {
      logger.info(`${prefix} skipped by rule ${rule.file}`);
      return { handled: true, reason: "smart-cron-skip" };
    }
    if (rule.failOpen) {
      logger.warn(`${prefix} gate error but failOpen=true; continuing. ${String(outcome.error)}`);
      return;
    }
    logger.error(`${prefix} gate failed; swallowing run. ${String(outcome.error)}`);
    return { handled: true, reason: "smart-cron-error" };
  };
}

export async function validateRules(host: HostBindings): Promise<void> {
  const rules = readRules(host);
  const logger = host.logger;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    try {
      await access(rule.resolvedFile, fsConstants.X_OK);
    } catch (err) {
      logger.warn(
        `smart-cron rule=${i}: file not executable or missing: ${rule.resolvedFile} (${String(err)})`,
      );
    }
    if (!rule.match || Object.keys(rule.match).length === 0) {
      logger.warn(`smart-cron rule=${i}: no match criteria; will fire on every cron/heartbeat`);
    }
    if (rule.failOpen && resolveRuleMode(rule) === "task") {
      logger.warn(
        `smart-cron rule=${i}: failOpen=true with mode=task is unusual (errors are swallowed regardless)`,
      );
    }
  }
}
