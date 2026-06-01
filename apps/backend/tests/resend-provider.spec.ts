// Resend email provider unit tests. Mocks global fetch so no network IO.
//
// We cover the three branches the dispatcher cares about:
//   - SENT: 200 OK + JSON body with `id`
//   - FAILED: 4xx with JSON `message`
//   - FAILED: network-throw → graceful return (not propagated)
//
// The provider must NEVER throw — it returns CommsSendResult.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResendProvider } from '../src/modules/comms/providers/resend-provider.js';

const origFetch = globalThis.fetch;

describe('ResendProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // @ts-expect-error — overriding the global for the test scope.
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('rejects with FAILED when `to` is missing', async () => {
    const p = new ResendProvider('test-key', 'noreply@spv.test');
    const r = await p.send({ to: '', body: 'hello' });
    expect(r.status).toBe('FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with FAILED when `body` is missing', async () => {
    const p = new ResendProvider('test-key', 'noreply@spv.test');
    const r = await p.send({ to: 'user@example.com', body: '' });
    expect(r.status).toBe('FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns SENT with providerId from Resend response on 200 OK', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'resend-msg-abc123' }), { status: 200 }),
    );
    const p = new ResendProvider('test-key', 'noreply@spv.test');
    const r = await p.send({ to: 'user@example.com', subject: 'Test', body: 'hello' });
    expect(r.status).toBe('SENT');
    expect(r.providerId).toBe('resend-msg-abc123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('returns FAILED on 4xx with upstream message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: 'invalid `to` field', statusCode: 422 }),
        { status: 422 },
      ),
    );
    const p = new ResendProvider('test-key', 'noreply@spv.test');
    const r = await p.send({ to: 'bad-address', body: 'hello' });
    expect(r.status).toBe('FAILED');
    if (r.status === 'FAILED') {
      expect(r.error).toContain('invalid');
    }
  });

  it('returns FAILED on network throw (never propagates)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const p = new ResendProvider('test-key', 'noreply@spv.test');
    const r = await p.send({ to: 'user@example.com', body: 'hello' });
    expect(r.status).toBe('FAILED');
    if (r.status === 'FAILED') {
      expect(r.error).toBe('fetch failed');
    }
  });

  it('constructor rejects empty apiKey + from', () => {
    expect(() => new ResendProvider('', 'noreply@spv.test')).toThrow();
    expect(() => new ResendProvider('test-key', '')).toThrow();
  });
});
