// Tests the ClamAV INSTREAM client by standing up a tiny TCP server fixture
// that replays the responses real clamd would send.
//
// CI environments without spare local ports can opt out by setting
// SKIP_AV_TESTS=1.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const skip = process.env['SKIP_AV_TESTS'] === '1';
const describeOrSkip = skip ? describe.skip : describe;

const { scanBuffer } = await import('../src/modules/documents/av.js');

// ---------------------------------------------------------------------------
// Tiny fake clamd. Each connection is fed a canned response after the client
// has finished sending its INSTREAM frames (we detect end-of-stream via the
// terminating four zero bytes).
// ---------------------------------------------------------------------------
function makeFakeClamd(reply: string): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let inStream = false;
      const buffers: Buffer[] = [];
      socket.on('data', (chunk) => {
        buffers.push(chunk);
        const all = Buffer.concat(buffers);
        // Peek for "zINSTREAM\0"
        if (!inStream) {
          const idx = all.indexOf(Buffer.from('zINSTREAM\0'));
          if (idx === -1) return;
          inStream = true;
        }
        // Look for terminating 0-length frame: scan trailing 4 bytes.
        if (all.length >= 4) {
          const tail = all.subarray(all.length - 4);
          if (tail.readUInt32BE(0) === 0) {
            // Send canned response and close.
            socket.write(reply, () => socket.end());
          }
        }
      });
      socket.on('error', () => undefined);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describeOrSkip('scanBuffer (clamd INSTREAM client)', () => {
  let cleanFix: { port: number; close: () => Promise<void> };
  let infectedFix: { port: number; close: () => Promise<void> };
  let garbageFix: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    cleanFix = await makeFakeClamd('stream: OK\0');
    infectedFix = await makeFakeClamd('stream: Eicar-Test-Signature FOUND\0');
    garbageFix = await makeFakeClamd('something completely unexpected\0');
  });

  afterAll(async () => {
    await cleanFix?.close();
    await infectedFix?.close();
    await garbageFix?.close();
  });

  it('returns CLEAN when clamd replies "stream: OK"', async () => {
    const r = await scanBuffer(Buffer.from('hello'), { host: '127.0.0.1', port: cleanFix.port, timeoutMs: 5000 });
    expect(r.result).toBe('CLEAN');
  });

  it('returns INFECTED with signature when clamd replies "stream: <SIG> FOUND"', async () => {
    const r = await scanBuffer(Buffer.from('virus'), {
      host: '127.0.0.1',
      port: infectedFix.port,
      timeoutMs: 5000,
    });
    expect(r.result).toBe('INFECTED');
    expect(r.signature).toBe('Eicar-Test-Signature');
  });

  it('fails closed (ERROR) on unexpected response', async () => {
    const r = await scanBuffer(Buffer.from('x'), {
      host: '127.0.0.1',
      port: garbageFix.port,
      timeoutMs: 5000,
    });
    expect(r.result).toBe('ERROR');
  });

  it('fails closed (ERROR) when clamd is unreachable', async () => {
    // Use a port we know is closed (high & ephemeral, not in use).
    const r = await scanBuffer(Buffer.from('x'), {
      host: '127.0.0.1',
      port: 1, // privileged + not bound; immediate ECONNREFUSED on most OSes
      timeoutMs: 1000,
    });
    expect(r.result).toBe('ERROR');
  });
});
