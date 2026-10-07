import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ReadError } from '@relate/protocol';

// Encryption also hides a continuation boundary belonging to a denied record.
export function cursorCodec(key: Uint8Array = randomBytes(32)) {
  if (key.length !== 32) throw new Error('Cursor key must contain 32 bytes');

  const secret = Buffer.from(key);

  return {
    encode(scope: string, after: string, expires: number) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([
        cipher.update(JSON.stringify({ scope, after, expires }), 'utf8'),
        cipher.final(),
      ]);

      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString(
        'base64url',
      );
    },
    decode(token: string, scope: string, now: number): string {
      try {
        if (token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token))
          throw new Error();

        const data = Buffer.from(token, 'base64url');

        if (data.toString('base64url') !== token || data.length < 29)
          throw new Error();

        const decipher = createDecipheriv(
          'aes-256-gcm',
          secret,
          data.subarray(0, 12),
        );

        decipher.setAuthTag(data.subarray(12, 28));
        const decoded: unknown = JSON.parse(
          Buffer.concat([
            decipher.update(data.subarray(28)),
            decipher.final(),
          ]).toString('utf8'),
        );

        if (
          !decoded ||
          typeof decoded !== 'object' ||
          !('scope' in decoded) ||
          decoded.scope !== scope ||
          !('expires' in decoded) ||
          typeof decoded.expires !== 'number' ||
          decoded.expires <= now ||
          !('after' in decoded) ||
          typeof decoded.after !== 'string'
        )
          throw new Error();

        return decoded.after;
      } catch {
        throw new ReadError('invalid-request');
      }
    },
  };
}
