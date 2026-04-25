import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeforeAgentReplyHandler } from '../core.mjs';

function makeApi(config) {
  return {
    config,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

test('declines non-cron/non-heartbeat triggers', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({ rules: [] }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'user' });
  assert.equal(result, undefined);
});

test('declines when no rule matches', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ match: { trigger: 'heartbeat', agentId: 'a' }, file: '/bin/true' }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'heartbeat', agentId: 'b' });
  assert.equal(result, undefined);
});

test('gate mode returns handled skip on exit 10', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ match: { trigger: 'heartbeat' }, file: '/bin/sh', args: ['-c', 'exit 10'] }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'heartbeat' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-skip' });
});

test('gate mode continues on exit 0', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ match: { trigger: 'cron' }, file: '/bin/true' }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.equal(result, undefined);
});

test('gate mode swallows errors by default', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ match: { trigger: 'cron' }, file: '/bin/sh', args: ['-c', 'exit 2'] }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-error' });
});

test('gate mode continues on errors when failOpen=true', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ match: { trigger: 'cron' }, file: '/bin/sh', args: ['-c', 'exit 2'], failOpen: true }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.equal(result, undefined);
});

test('task mode handles scheduled task success without waking agent', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ mode: 'task', match: { trigger: 'cron' }, file: '/bin/true' }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-task-complete' });
});

test('task mode handles skip exit without waking agent', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ mode: 'task', match: { trigger: 'heartbeat' }, file: '/bin/sh', args: ['-c', 'exit 10'] }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'heartbeat' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-task-skip' });
});

test('task mode swallows task failures by default', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ mode: 'task', match: { trigger: 'cron' }, file: '/bin/sh', args: ['-c', 'exit 2'] }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-task-error' });
});

test('task mode returns handled ignored error when failOpen=true', async () => {
  const handler = createBeforeAgentReplyHandler(makeApi({
    rules: [{ mode: 'task', match: { trigger: 'cron' }, file: '/bin/sh', args: ['-c', 'exit 2'], failOpen: true }],
  }));
  const result = await handler({ cleanedBody: 'x' }, { trigger: 'cron' });
  assert.deepEqual(result, { handled: true, reason: 'smart-scheduler-task-error-ignored' });
});
