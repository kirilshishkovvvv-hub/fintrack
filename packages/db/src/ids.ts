import { randomBytes } from 'node:crypto';

/**
 * UUID version 7 (RFC 9562): a 48-bit millisecond timestamp followed by random bits (AD-18).
 * Unguessable (BR-02.5) and index-friendly; it does reveal the creation time.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
