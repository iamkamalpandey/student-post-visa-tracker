// ClamAV INSTREAM client (pure Node, no external dependencies).
// ----------------------------------------------------------------------------
// Wire protocol (clamd, plaintext mode on TCP/3310):
//
//   client → "zINSTREAM\0"
//   client → [u32 BE chunk_size][bytes]   ...repeat for each chunk...
//   client → [u32 BE 0]                   (zero-length chunk = end of stream)
//   server → "stream: OK\0"               (clean)
//   server → "stream: <SIGNATURE> FOUND\0" (infected)
//   server → "INSTREAM size limit exceeded ERROR\0" (too big / error)
//
// The leading 'z' in "zINSTREAM" tells clamd to expect a NUL-terminated
// command (as opposed to 'n' which uses newline). We use NUL-termination
// because it is unambiguous when the response also ends in NUL.
//
// Fail-closed semantics
// ---------------------
// Any unexpected response, parse failure, socket error, or timeout maps to
// `ScanResult = 'ERROR'`. Callers MUST treat ERROR conservatively (e.g. mark
// av_status = ERROR, do not serve the file until the scan succeeds). This
// document never instructs callers to treat ERROR as CLEAN.

import * as net from 'node:net';

export type ScanResult = 'CLEAN' | 'INFECTED' | 'ERROR';

export interface ScanOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  /** Chunk size for INSTREAM frames (default 64 KiB). */
  chunkSize?: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK = 64 * 1024;

export async function scanBuffer(
  buf: Buffer,
  opts: ScanOptions = {},
): Promise<{ result: ScanResult; signature?: string }> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (out: { result: ScanResult; signature?: string }) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* noop */ }
      clearTimeout(timer);
      resolve(out);
    };

    const socket = net.createConnection({ host, port }, () => {
      try {
        // Send the command, NUL-terminated (the 'z' prefix variant).
        socket.write('zINSTREAM\0');

        // Frame the buffer in chunkSize windows.
        for (let off = 0; off < buf.length; off += chunkSize) {
          const slice = buf.subarray(off, Math.min(off + chunkSize, buf.length));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.length, 0);
          socket.write(header);
          socket.write(slice);
        }
        // Terminator: a zero-length chunk.
        const term = Buffer.alloc(4);
        term.writeUInt32BE(0, 0);
        socket.write(term);
      } catch {
        finish({ result: 'ERROR' });
      }
    });

    const timer = setTimeout(() => finish({ result: 'ERROR' }), timeoutMs);

    socket.setNoDelay(true);
    socket.on('data', (d) => chunks.push(d));
    socket.on('error', () => finish({ result: 'ERROR' }));
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/\0+$/g, '').trim();
      // Expected forms:
      //   "stream: OK"
      //   "stream: Eicar-Test-Signature FOUND"
      //   "stream: <reason> ERROR"
      const okMatch = /^stream:\s*OK$/i.exec(text);
      if (okMatch) return finish({ result: 'CLEAN' });

      const foundMatch = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
      if (foundMatch && foundMatch[1]) return finish({ result: 'INFECTED', signature: foundMatch[1] });

      // Anything else: treat as ERROR (fail-closed).
      finish({ result: 'ERROR' });
    });
    socket.on('close', () => {
      // If close fires before end (e.g. RST), and we haven't settled, error.
      finish({ result: 'ERROR' });
    });
  });
}
