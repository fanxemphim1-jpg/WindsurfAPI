import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { isCascadeTransportError, isLocalCascadeTransportError, isUpstreamModelTimeout } from '../src/client.js';
import { chatStreamError, isUpstreamTransientError, redactRequestLogText, pickBackoffKind, plannedBackoffMs } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';

function parseEvents(raw) {
  return raw.trim().split('\n\n').filter(Boolean).map(frame => {
    const lines = frame.split('\n');
    return {
      event: lines.find(line => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
    };
  });
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

describe('stream error protocol', () => {
  it('creates OpenAI-style structured stream errors', () => {
    assert.deepEqual(chatStreamError('boom', 'upstream_error', 'x'), {
      error: { message: 'boom', type: 'upstream_error', code: 'x' },
    });
  });

  it('classifies Cascade HTTP/2 cancellation as upstream transient', () => {
    const err = new Error('The pending stream has been canceled (caused by: )');
    assert.equal(isCascadeTransportError(err), true);
    assert.equal(isUpstreamTransientError(err), true);
    assert.equal(isUpstreamTransientError(new Error('permission_denied: model unavailable')), false);
  });

  it('classifies upstream "context deadline exceeded" / Client.Timeout / retryable errors as transient', () => {
    // Codeium streams these strings back when the model provider drops the
    // long-poll body. Without classifying as transport, the retry loop
    // treats them as model_error and gives up after the first account.
    const cases = [
      'Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)',
      'context deadline exceeded',
      'Client.Timeout exceeded while awaiting headers',
      'context cancellation while reading body',
      'read ETIMEDOUT',
      'socket hang up',
    ];
    for (const msg of cases) {
      const err = new Error(msg);
      assert.equal(isCascadeTransportError(err), true, `expected transport for: ${msg}`);
      assert.equal(isUpstreamTransientError(err), true, `expected transient for: ${msg}`);
    }
    // Negative case — a genuine model error must still NOT be classified
    // as transient (otherwise we'd silently retry permanent failures).
    assert.equal(isCascadeTransportError(new Error('permission_denied: model unavailable')), false);
  });

  it('separates local LS jitter from upstream model-provider timeouts', () => {
    // Local LS / HTTP/2 jitter — recovers in a few hundred ms.
    const local = [
      'pending stream has been canceled',
      'ECONNRESET',
      'ERR_HTTP2_STREAM_ERROR',
      'session closed unexpectedly',
      'panel state missing on Send',
    ];
    for (const msg of local) {
      const err = new Error(msg);
      assert.equal(isLocalCascadeTransportError(err), true, `expected local for: ${msg}`);
      assert.equal(isUpstreamModelTimeout(err), false, `should not be upstream for: ${msg}`);
      assert.equal(isCascadeTransportError(err), true);
    }
    // Upstream model-provider deadline — needs longer rate-shape backoff.
    const upstream = [
      'Encountered retryable error from model provider: context deadline exceeded',
      'Client.Timeout exceeded while awaiting headers',
      'context cancellation while reading body',
      'read ETIMEDOUT',
      'socket hang up',
      'unexpected EOF',
    ];
    for (const msg of upstream) {
      const err = new Error(msg);
      assert.equal(isUpstreamModelTimeout(err), true, `expected upstream for: ${msg}`);
      assert.equal(isLocalCascadeTransportError(err), false, `should not be local for: ${msg}`);
      assert.equal(isCascadeTransportError(err), true);
    }
  });

  it('pickBackoffKind routes to the correct backoff profile', () => {
    assert.equal(
      pickBackoffKind(new Error('Encountered retryable error from model provider: context deadline exceeded')),
      'model_timeout',
    );
    assert.equal(
      pickBackoffKind(new Error('pending stream has been canceled')),
      'cascade_transport',
    );
    assert.equal(
      pickBackoffKind(new Error('Cascade internal error occurred. Error ID: abc'), { isInternal: true }),
      'internal_error',
    );
    // Unknown error — fall back to internal_error rather than skipping
    // backoff entirely.
    assert.equal(
      pickBackoffKind(new Error('weird unrelated error')),
      'internal_error',
    );
  });

  it('plannedBackoffMs respects per-profile caps and doubles each retry', () => {
    // cascade_transport: 200, 400, 800, 1500 (cap)
    assert.equal(plannedBackoffMs(0, 'cascade_transport'), 200);
    assert.equal(plannedBackoffMs(1, 'cascade_transport'), 400);
    assert.equal(plannedBackoffMs(2, 'cascade_transport'), 800);
    assert.equal(plannedBackoffMs(3, 'cascade_transport'), 1500);
    assert.equal(plannedBackoffMs(10, 'cascade_transport'), 1500);

    // internal_error: 500, 1000, 2000, 4000, 5000 (cap) — preserves legacy.
    assert.equal(plannedBackoffMs(0, 'internal_error'), 500);
    assert.equal(plannedBackoffMs(3, 'internal_error'), 4000);
    assert.equal(plannedBackoffMs(4, 'internal_error'), 5000);
    assert.equal(plannedBackoffMs(99, 'internal_error'), 5000);

    // model_timeout: 1000, 2000, 4000, 8000, 12000 (cap).
    assert.equal(plannedBackoffMs(0, 'model_timeout'), 1000);
    assert.equal(plannedBackoffMs(1, 'model_timeout'), 2000);
    assert.equal(plannedBackoffMs(3, 'model_timeout'), 8000);
    assert.equal(plannedBackoffMs(4, 'model_timeout'), 12000);
    assert.equal(plannedBackoffMs(99, 'model_timeout'), 12000);

    // Unknown profile falls back to internal_error.
    assert.equal(plannedBackoffMs(0, 'unknown_profile'), 500);

    // Negative / NaN retryIdx clamps to 0.
    assert.equal(plannedBackoffMs(-5, 'model_timeout'), 1000);
    assert.equal(plannedBackoffMs(NaN, 'model_timeout'), 1000);
  });

  it('redacts common secret patterns before debug request-body logging', () => {
    const redacted = redactRequestLogText('sk-1234567890abcdefghijklmnop test@example.com Cookie: session=abc eyJabc.def.ghi AKIAABCDEFGHIJKLMNOP');
    assert.doesNotMatch(redacted, /sk-1234567890/);
    assert.doesNotMatch(redacted, /test@example\.com/);
    assert.doesNotMatch(redacted, /session=abc/);
    assert.doesNotMatch(redacted, /eyJabc\.def\.ghi/);
    assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
  });

  it('translates structured chat stream errors to Anthropic error events', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('boom', 'upstream_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.error.message, 'boom');
  });

  it('preserves upstream_transient_error in Anthropic stream errors', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('cascade transport canceled', 'upstream_transient_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.error.type, 'upstream_transient_error');
  });

  it('routes oversized Connect frame parser errors to onError without throwing from data handlers', async () => {
    const previousProtocol = process.env.GRPC_PROTOCOL;
    process.env.GRPC_PROTOCOL = 'connect';
    const grpc = await import(`../src/grpc.js?connect-error-test=${Date.now()}`);

    const server = http2.createServer();
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      const frame = Buffer.alloc(5);
      frame[0] = 0;
      frame.writeUInt32BE(16 * 1024 * 1024 + 1, 1);
      stream.end(frame);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for parser error')), 1000);
        grpc.grpcStream(port, 'csrf', '/exa.language_server_pb.LanguageServerService/RawGetChatMessage', Buffer.from('{}'), {
          timeout: 1000,
          onData() {
            reject(new Error('unexpected data callback'));
          },
          onEnd() {
            reject(new Error('unexpected end callback'));
          },
          onError(error) {
            clearTimeout(timer);
            resolve(error);
          },
        });
      });

      assert.match(err.message, /exceeds 16777216/);
    } finally {
      grpc.closeSessionForPort(port);
      await new Promise(resolve => server.close(resolve));
      if (previousProtocol == null) delete process.env.GRPC_PROTOCOL;
      else process.env.GRPC_PROTOCOL = previousProtocol;
    }
  });
});
