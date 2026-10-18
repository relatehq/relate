import { randomBytes } from 'node:crypto';

let lastMs = 0;
let sequence = 0;

/**
 * RFC 9562 UUIDv7: millisecond time order with a 12-bit in-process sequence,
 * so IDs from one runtime sort by creation even within a millisecond.
 */
export function uuidv7(now = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    sequence = randomBytes(2).readUInt16BE() & 0x3ff;
  } else if (++sequence > 0xfff) {
    lastMs++;
    sequence = 0;
  }

  const bytes = randomBytes(16);
  const ms = BigInt(lastMs);

  for (let index = 0; index < 6; index++)
    bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn);

  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
