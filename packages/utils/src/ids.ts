// UUID v7 generator (time-ordered, monotonic). Used app-side as a fallback when the DB extension
// uuid_generate_v7() is unavailable. Implementation follows draft RFC 9562 §5.7.
import { randomBytes } from 'node:crypto';

export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const tsBytes = Buffer.alloc(6);
  tsBytes.writeUIntBE(Number(ts >> 16n), 0, 4);
  tsBytes.writeUIntBE(Number(ts & 0xffffn), 4, 2);

  const rand = randomBytes(10);
  rand[0] = (rand[0]! & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2]! & 0x3f) | 0x80; // RFC 4122 variant

  const bytes = Buffer.concat([tsBytes, rand]);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
