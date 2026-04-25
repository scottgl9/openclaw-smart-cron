import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_SKIP_EXIT_CODES = new Set([10]);
const MAX_BUFFER = 64 * 1024;
const LOG_OUTPUT_MAX_CHARS = 4096;

function clampTimeout(timeoutSeconds) {
  if (!Number.isFinite(timeoutSeconds)) return DEFAULT_TIMEOUT_MS;
  const ms = Math.trunc((timeoutSeconds ?? 30) * 1000);
  return Math.max(1000, Math.min(ms, MAX_TIMEOUT_MS));
}

function truncateForLog(value) {
  if (!value) return '';
  return value.length > LOG_OUTPUT_MAX_CHARS ? `${value.slice(0, LOG_OUTPUT_MAX_CHARS)}…` : value;
}

function normalizeOutput(value) {
  return typeof value === 'string' ? value : '';
}

function resolveRuleMode(rule) {
  return rule.mode === 'task' ? 'task' : 'gate';
}

function matchesRule(rule, ctx) {
  const match = rule.match;
  if (!match) return true;
  if (match.trigger && ctx.trigger !== match.trigger) return false;
  if (match.agentId && ctx.agentId !== match.agentId) return false;
  if (match.sessionKey && ctx.sessionKey !== match.sessionKey) return false;
  if (match.reasonIncludes && !(ctx.reason ?? '').includes(match.reasonIncludes)) return false;
  return true;
}

async function runRule(rule) {
  const timeout = clampTimeout(rule.timeoutSeconds);
  const skipExitCodes = new Set(rule.skipExitCodes?.length ? rule.skipExitCodes : Array.from(DEFAULT_SKIP_EXIT_CODES));

  try {
    const result = await execFileAsync(rule.file, rule.args ?? [], {
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    return {
      kind: 'continue',
      exitCode: 0,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
    };
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : null;
    const stdout = normalizeOutput(error?.stdout);
    const stderr = normalizeOutput(error?.stderr);

    if (code !== null && skipExitCodes.has(code)) {
      return {
        kind: 'skip',
        exitCode: code,
        stdout,
        stderr,
      };
    }

    return {
      kind: 'error',
      exitCode: code,
      stdout,
      stderr,
      error,
    };
  }
}

export function createBeforeAgentReplyHandler(api) {
  return async (_event, ctx) => {
    if (ctx.trigger !== 'cron' && ctx.trigger !== 'heartbeat') return;

    const config = api.config ?? {};
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const rule = rules.find((candidate) => matchesRule(candidate, ctx));
    if (!rule) return;

    const mode = resolveRuleMode(rule);
    const outcome = await runRule(rule);
    const prefix = `smart-scheduler: ${ctx.trigger}${ctx.agentId ? ` agent=${ctx.agentId}` : ''} mode=${mode}`;

    if (rule.logOutput && (outcome.stdout || outcome.stderr)) {
      api.logger.info(
        `${prefix} stdout=${JSON.stringify(truncateForLog(outcome.stdout))} stderr=${JSON.stringify(truncateForLog(outcome.stderr))}`,
      );
    }

    if (mode === 'task') {
      if (outcome.kind === 'continue') {
        api.logger.info(`${prefix} task completed (exit=${outcome.exitCode ?? '0'})`);
        return {
          handled: true,
          reason: 'smart-scheduler-task-complete',
        };
      }

      if (outcome.kind === 'skip') {
        api.logger.info(`${prefix} task skipped (exit=${outcome.exitCode ?? 'unknown'})`);
        return {
          handled: true,
          reason: 'smart-scheduler-task-skip',
        };
      }

      if (rule.failOpen) {
        api.logger.warn(`${prefix} task error but failOpen=true; swallowing scheduled turn. ${String(outcome.error)}`);
        return {
          handled: true,
          reason: 'smart-scheduler-task-error-ignored',
        };
      }

      api.logger.error(`${prefix} task failed; swallowing scheduled turn. ${String(outcome.error)}`);
      return {
        handled: true,
        reason: 'smart-scheduler-task-error',
      };
    }

    if (outcome.kind === 'continue') {
      api.logger.info(`${prefix} continuing to agent (exit=${outcome.exitCode ?? '0'})`);
      return;
    }

    if (outcome.kind === 'skip') {
      api.logger.info(`${prefix} skipped by rule ${rule.file} (exit=${outcome.exitCode ?? 'unknown'})`);
      return {
        handled: true,
        reason: 'smart-scheduler-skip',
      };
    }

    if (rule.failOpen) {
      api.logger.warn(`${prefix} gate error but failOpen=true; continuing. ${String(outcome.error)}`);
      return;
    }

    api.logger.error(`${prefix} gate failed; swallowing run. ${String(outcome.error)}`);
    return {
      handled: true,
      reason: 'smart-scheduler-error',
    };
  };
}
