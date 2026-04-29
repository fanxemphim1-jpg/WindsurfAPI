import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount,
  recordHealthEvent, accountHealthScore,
  hasCreditsRemaining,
  getApiKey, reportSuccess,
} from '../src/auth.js';

// addAccountByKey returns a live reference to the account object in the
// pool — mutations are visible to getApiKey/etc. immediately.

// ─── Health scoring ────────────────────────────────────────

describe('accountHealthScore — sliding window success ratio', () => {
  let acct;
  it('returns 1.0 for accounts with no events', () => {
    acct = addAccountByKey('test-health-key-' + Date.now(), 'test-health');
    assert.equal(accountHealthScore(acct.apiKey), 1.0);
  });

  it('returns 1.0 after all successes', () => {
    recordHealthEvent(acct.apiKey, true);
    recordHealthEvent(acct.apiKey, true);
    recordHealthEvent(acct.apiKey, true);
    assert.equal(accountHealthScore(acct.apiKey), 1.0);
  });

  it('returns 0.0 after all failures', () => {
    const acct2 = addAccountByKey('test-health-key2-' + Date.now(), 'test-health2');
    recordHealthEvent(acct2.apiKey, false);
    recordHealthEvent(acct2.apiKey, false);
    recordHealthEvent(acct2.apiKey, false);
    assert.equal(accountHealthScore(acct2.apiKey), 0.0);
    removeAccount(acct2.id);
  });

  it('returns mixed ratio correctly', () => {
    const acct3 = addAccountByKey('test-health-key3-' + Date.now(), 'test-health3');
    recordHealthEvent(acct3.apiKey, true);
    recordHealthEvent(acct3.apiKey, true);
    recordHealthEvent(acct3.apiKey, false);
    recordHealthEvent(acct3.apiKey, true);
    // 3 success, 1 failure = 0.75
    assert.equal(accountHealthScore(acct3.apiKey), 0.75);
    removeAccount(acct3.id);
  });

  it('returns 0 for unknown apiKey', () => {
    assert.equal(accountHealthScore('nonexistent-key'), 0);
  });

  it('cleanup', () => { removeAccount(acct.id); });
});

// ─── Credit awareness ──────────────────────────────────────

describe('hasCreditsRemaining — credit-based filtering', () => {
  it('returns true when no credit data is available (benefit of doubt)', () => {
    const acct = addAccountByKey('test-credit-nodata-' + Date.now(), 'test-credit');
    assert.equal(hasCreditsRemaining(acct.apiKey), true);
    removeAccount(acct.id);
  });

  it('returns true when credits are available via userStatus', () => {
    const acct = addAccountByKey('test-credit-avail-' + Date.now(), 'test-credit');
    acct.userStatus = { monthlyPromptCredits: 100, promptCreditsUsed: 30 };
    assert.equal(hasCreditsRemaining(acct.apiKey), true);
    removeAccount(acct.id);
  });

  it('returns false when credits are depleted via userStatus', () => {
    const acct = addAccountByKey('test-credit-depleted-' + Date.now(), 'test-credit');
    acct.userStatus = { monthlyPromptCredits: 100, promptCreditsUsed: 100 };
    assert.equal(hasCreditsRemaining(acct.apiKey), false);
    removeAccount(acct.id);
  });

  it('returns false for unknown apiKey', () => {
    assert.equal(hasCreditsRemaining('nonexistent-key'), false);
  });
});

// ─── getApiKey sorting — health + credits ──────────────────

describe('getApiKey — prefers healthy accounts with credits', () => {
  let acctHealthy, acctUnhealthy, acctDepleted;

  it('setup: create 3 accounts with different health and credit states', () => {
    const ts = Date.now();
    acctHealthy = addAccountByKey('test-sort-healthy-' + ts, 'healthy');
    acctUnhealthy = addAccountByKey('test-sort-unhealthy-' + ts, 'unhealthy');
    acctDepleted = addAccountByKey('test-sort-depleted-' + ts, 'depleted');

    // Make them all pro tier so they're eligible
    acctHealthy.tier = 'pro';
    acctUnhealthy.tier = 'pro';
    acctDepleted.tier = 'pro';

    // Record health events: healthy = all success, unhealthy = all failure
    for (let i = 0; i < 5; i++) recordHealthEvent(acctHealthy.apiKey, true);
    for (let i = 0; i < 5; i++) recordHealthEvent(acctUnhealthy.apiKey, false);
    for (let i = 0; i < 5; i++) recordHealthEvent(acctDepleted.apiKey, true);

    // Deplete credits on the depleted account
    acctDepleted.userStatus = { monthlyPromptCredits: 100, promptCreditsUsed: 100 };

    // Clear error state
    reportSuccess(acctHealthy.apiKey);
    reportSuccess(acctUnhealthy.apiKey);
    reportSuccess(acctDepleted.apiKey);
  });

  it('picks the healthy account with credits first', () => {
    const picked = getApiKey([], null);
    assert.ok(picked, 'should return an account');
    assert.equal(picked.apiKey, acctHealthy.apiKey,
      'should prefer healthy account with credits');
  });

  it('picks unhealthy-with-credits over depleted when healthy is excluded', () => {
    const picked = getApiKey([acctHealthy.apiKey], null);
    assert.ok(picked, 'should return an account');
    // Credit check (ratio > 0) wins over health score
    assert.equal(picked.apiKey, acctUnhealthy.apiKey,
      'should prefer unhealthy-with-credits over healthy-but-depleted');
  });

  it('falls back to depleted account rather than returning null', () => {
    const picked = getApiKey([acctHealthy.apiKey, acctUnhealthy.apiKey], null);
    assert.ok(picked, 'depleted account should still be selectable');
    assert.equal(picked.apiKey, acctDepleted.apiKey);
  });

  it('cleanup', () => {
    removeAccount(acctHealthy.id);
    removeAccount(acctUnhealthy.id);
    removeAccount(acctDepleted.id);
  });
});
