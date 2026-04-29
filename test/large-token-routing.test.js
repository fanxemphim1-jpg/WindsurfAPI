import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateMessagesBytes,
  findOneMillionVariant,
  shouldAutoRouteOneMillion,
  toolPreambleCapsForModel,
} from '../src/handlers/chat.js';
import { cascadeHistoryBudget } from '../src/client.js';
import {
  addAccountByKey,
  removeAccount,
  reportInternalError,
  reportSuccess,
} from '../src/auth.js';

test('cascadeHistoryBudget — defaults match the per-family budget table', () => {
  // 1M-context variants pick up the 3.5MB default
  assert.equal(cascadeHistoryBudget('claude-sonnet-4-6-1m'), 3_500_000);
  assert.equal(cascadeHistoryBudget('claude-sonnet-4-6-thinking-1m'), 3_500_000);

  // Anthropic 200K-context family gets 600KB
  assert.equal(cascadeHistoryBudget('claude-sonnet-4-6'), 600_000);
  assert.equal(cascadeHistoryBudget('claude-opus-4-7-medium'), 600_000);
  assert.equal(cascadeHistoryBudget('claude-3.7-sonnet'), 600_000);

  // OpenAI long-context families
  assert.equal(cascadeHistoryBudget('gpt-5.2'), 600_000);
  assert.equal(cascadeHistoryBudget('gpt-5.1-mini'), 600_000);

  // Gemini 2.x — 1.5M
  assert.equal(cascadeHistoryBudget('gemini-2.5-pro'), 1_500_000);

  // Unknown model falls back to env default (600K)
  assert.equal(cascadeHistoryBudget('mystery-model-999'), 600_000);
});

test('cascadeHistoryBudget — env overrides win', () => {
  const prev = process.env.CASCADE_HISTORY_BUDGETS;
  try {
    process.env.CASCADE_HISTORY_BUDGETS = JSON.stringify({
      'claude-sonnet-4-6$': 1_000_000,
      'mystery-model': 250_000,
    });
    assert.equal(cascadeHistoryBudget('claude-sonnet-4-6'), 1_000_000);
    assert.equal(cascadeHistoryBudget('mystery-model-999'), 250_000);
    // 1m suffix still wins via the table because override doesn't match it
    assert.equal(cascadeHistoryBudget('claude-sonnet-4-6-1m'), 3_500_000);
  } finally {
    if (prev === undefined) delete process.env.CASCADE_HISTORY_BUDGETS;
    else process.env.CASCADE_HISTORY_BUDGETS = prev;
  }
});

test('cascadeHistoryBudget — invalid env JSON does not throw', () => {
  const prev = process.env.CASCADE_HISTORY_BUDGETS;
  try {
    process.env.CASCADE_HISTORY_BUDGETS = '{invalid json';
    // Falls through to defaults
    assert.equal(cascadeHistoryBudget('claude-sonnet-4-6'), 600_000);
  } finally {
    if (prev === undefined) delete process.env.CASCADE_HISTORY_BUDGETS;
    else process.env.CASCADE_HISTORY_BUDGETS = prev;
  }
});

test('estimateMessagesBytes — counts strings, structured text parts, and tool_call args', () => {
  const messages = [
    { role: 'system', content: 'hello' }, // 5
    { role: 'user', content: [
      { type: 'text', text: 'world' }, // 5
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aaaa' } }, // not counted
    ] },
    { role: 'assistant', content: 'ok', tool_calls: [
      { id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }, // 6 + 9 = 15
    ] },
    null,
    { role: 'user', content: 'ý'.repeat(3) /* 6 utf8 bytes */ },
  ];
  // 5 + 5 + 2 + 15 + 6 = 33
  assert.equal(estimateMessagesBytes(messages), 33);
});

test('findOneMillionVariant — resolves base → -1m and -thinking → -thinking-1m', () => {
  assert.equal(findOneMillionVariant('claude-sonnet-4.6'), 'claude-sonnet-4.6-1m');
  assert.equal(findOneMillionVariant('claude-sonnet-4.6-thinking'), 'claude-sonnet-4.6-thinking-1m');
  // Already 1m — returns same key (idempotent)
  assert.equal(findOneMillionVariant('claude-sonnet-4.6-1m'), 'claude-sonnet-4.6-1m');
  // Model without a 1m variant
  assert.equal(findOneMillionVariant('claude-3.5-sonnet'), null);
  assert.equal(findOneMillionVariant(null), null);
  assert.equal(findOneMillionVariant(''), null);
});

test('shouldAutoRouteOneMillion — gated by env flag, respects threshold, skips when no variant', () => {
  const prevFlag = process.env.CASCADE_AUTO_ROUTE_1M;
  const prevBytes = process.env.CASCADE_AUTO_ROUTE_1M_BYTES;
  try {
    delete process.env.CASCADE_AUTO_ROUTE_1M;
    delete process.env.CASCADE_AUTO_ROUTE_1M_BYTES;

    // Off by default
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 10_000_000, baseModelKey: 'claude-sonnet-4.6', hasOneMVariant: true,
    }), false);

    process.env.CASCADE_AUTO_ROUTE_1M = 'true';

    // Below default 400KB threshold → no route
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 100_000, baseModelKey: 'claude-sonnet-4.6', hasOneMVariant: true,
    }), false);

    // At/above threshold → route
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 400_000, baseModelKey: 'claude-sonnet-4.6', hasOneMVariant: true,
    }), true);

    // No 1m variant → never route
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 1_000_000, baseModelKey: 'claude-3.5-sonnet', hasOneMVariant: false,
    }), false);

    // Already on a 1m model → no double-route
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 1_000_000, baseModelKey: 'claude-sonnet-4.6-1m', hasOneMVariant: true,
    }), false);

    // Custom threshold via env
    process.env.CASCADE_AUTO_ROUTE_1M_BYTES = '50000';
    assert.equal(shouldAutoRouteOneMillion({
      payloadBytes: 60_000, baseModelKey: 'claude-sonnet-4.6', hasOneMVariant: true,
    }), true);
  } finally {
    if (prevFlag === undefined) delete process.env.CASCADE_AUTO_ROUTE_1M;
    else process.env.CASCADE_AUTO_ROUTE_1M = prevFlag;
    if (prevBytes === undefined) delete process.env.CASCADE_AUTO_ROUTE_1M_BYTES;
    else process.env.CASCADE_AUTO_ROUTE_1M_BYTES = prevBytes;
  }
});

test('reportInternalError — quarantine streak threshold is configurable', () => {
  const acct = addAccountByKey(`test-quarantine-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'qrtn');
  const prev = process.env.INTERNAL_ERROR_STREAK_QUARANTINE;
  try {
    // Default threshold is now 4 (was 2 pre-v2.0.30) — three failures should
    // not yet take the account out of rotation, so a transient blip in a
    // single user-visible request can't poison the pool for 5 minutes.
    delete process.env.INTERNAL_ERROR_STREAK_QUARANTINE;
    reportInternalError(acct.apiKey);
    reportInternalError(acct.apiKey);
    reportInternalError(acct.apiKey);
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now(),
      'streak below default threshold should not quarantine');
    reportInternalError(acct.apiKey);
    assert.ok(acct.rateLimitedUntil > Date.now(),
      'streak meeting default threshold should quarantine');

    // reportSuccess clears the streak
    reportSuccess(acct.apiKey);
    assert.equal(acct.internalErrorStreak, 0);

    // Custom threshold honoured
    acct.rateLimitedUntil = 0;
    process.env.INTERNAL_ERROR_STREAK_QUARANTINE = '2';
    reportInternalError(acct.apiKey);
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now());
    reportInternalError(acct.apiKey);
    assert.ok(acct.rateLimitedUntil > Date.now(),
      'custom threshold of 2 should quarantine on the second hit');
  } finally {
    if (prev === undefined) delete process.env.INTERNAL_ERROR_STREAK_QUARANTINE;
    else process.env.INTERNAL_ERROR_STREAK_QUARANTINE = prev;
    removeAccount(acct.id);
  }
});

test('toolPreambleCapsForModel — scales caps for 1m models', () => {
  const base = toolPreambleCapsForModel('claude-sonnet-4.6');
  assert.equal(base.softBytes, 24_000);
  assert.equal(base.hardBytes, 48_000);

  const oneM = toolPreambleCapsForModel('claude-sonnet-4.6-1m');
  assert.equal(oneM.softBytes, 64_000);
  assert.equal(oneM.hardBytes, 96_000);

  const oneMThinking = toolPreambleCapsForModel('claude-sonnet-4.6-thinking-1m');
  assert.equal(oneMThinking.softBytes, 64_000);

  // Env override on the 1m-specific knob
  const prev = process.env.TOOL_PREAMBLE_SOFT_BYTES_1M;
  try {
    process.env.TOOL_PREAMBLE_SOFT_BYTES_1M = '120000';
    assert.equal(toolPreambleCapsForModel('claude-sonnet-4.6-1m').softBytes, 120_000);
    // Base model unaffected
    assert.equal(toolPreambleCapsForModel('claude-sonnet-4.6').softBytes, 24_000);
  } finally {
    if (prev === undefined) delete process.env.TOOL_PREAMBLE_SOFT_BYTES_1M;
    else process.env.TOOL_PREAMBLE_SOFT_BYTES_1M = prev;
  }
});
