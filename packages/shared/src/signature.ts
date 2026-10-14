import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIMITS } from './constants';

const SIGNATURE_FORMAT = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP_FORMAT = /^[0-9]{1,12}$/;

/** HMAC-SHA256 over `${timestamp}.${rawBody}`, formatted as `v1=<hex>`. */
export function signPayload(
  secret: string,
  timestampSeconds: number | string,
  rawBody: string | Buffer,
): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestampSeconds}.`);
  mac.update(rawBody);
  return `v1=${mac.digest('hex')}`;
}

export type SignatureFailureCode =
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'timestamp_out_of_window'
  | 'signature_mismatch';

export type SignatureVerdict = { ok: true } | { ok: false; code: SignatureFailureCode };

export interface VerifyInput {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowMs: number;
  toleranceSeconds?: number;
}

/**
 * Verifies a signature on the raw request bytes. Format and length are validated before the
 * constant-time comparison so `timingSafeEqual` always receives equal-length buffers.
 */
export function verifySignature(input: VerifyInput): SignatureVerdict {
  const tolerance = input.toleranceSeconds ?? LIMITS.signatureToleranceSeconds;
  if (input.signatureHeader === undefined || input.signatureHeader === '') {
    return { ok: false, code: 'missing_signature' };
  }
  const match = SIGNATURE_FORMAT.exec(input.signatureHeader);
  if (!match) return { ok: false, code: 'malformed_signature' };

  if (input.timestampHeader === undefined || input.timestampHeader === '') {
    return { ok: false, code: 'missing_timestamp' };
  }
  if (!TIMESTAMP_FORMAT.test(input.timestampHeader)) {
    return { ok: false, code: 'malformed_timestamp' };
  }
  const tsSeconds = Number(input.timestampHeader);
  if (Math.abs(input.nowMs / 1000 - tsSeconds) > tolerance) {
    return { ok: false, code: 'timestamp_out_of_window' };
  }

  const expected = Buffer.from(
    signPayload(input.secret, input.timestampHeader, input.rawBody).slice(3),
    'hex',
  );
  const provided = Buffer.from(match[1]!, 'hex');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, code: 'signature_mismatch' };
  }
  return { ok: true };
}
