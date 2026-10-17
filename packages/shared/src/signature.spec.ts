import { HEADERS, LIMITS } from './constants';
import { deterministicUuid, envelopeSchema, serializeEnvelope, sha256Hex } from './envelope';
import { signPayload, verifySignature } from './signature';

const secret = 'unit-test-secret';
const body = Buffer.from('{"id":"x"}');
const nowMs = Date.parse('2026-01-01T00:00:00Z');
const ts = String(Math.floor(nowMs / 1000));

const verify = (over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    secret,
    timestampHeader: ts,
    signatureHeader: signPayload(secret, ts, body),
    rawBody: body,
    nowMs,
    ...over,
  });

describe('signature', () => {
  it('accepts a valid signature over timestamp.rawBody', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('signs exactly `${timestamp}.${rawBody}`', () => {
    const sig = signPayload(secret, '123', 'abc');
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signPayload(secret, '123', Buffer.from('abc'))).toBe(sig);
    expect(signPayload(secret, '124', 'abc')).not.toBe(sig);
  });

  it('rejects a tampered body', () => {
    expect(verify({ rawBody: Buffer.from('{"id":"y"}') })).toEqual({
      ok: false,
      code: 'signature_mismatch',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verify({ signatureHeader: signPayload('other', ts, body) })).toEqual({
      ok: false,
      code: 'signature_mismatch',
    });
  });

  it.each([
    ['uppercase hex', `v1=${'A'.repeat(64)}`],
    ['too short', 'v1=abcd'],
    ['too long', `v1=${'a'.repeat(65)}`],
    ['no scheme', 'a'.repeat(64)],
    ['wrong scheme', `v2=${'a'.repeat(64)}`],
  ])('rejects malformed signature: %s', (_, header) => {
    expect(verify({ signatureHeader: header })).toEqual({ ok: false, code: 'malformed_signature' });
  });

  it('reports missing headers', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({
      ok: false,
      code: 'missing_signature',
    });
    expect(verify({ timestampHeader: undefined })).toEqual({
      ok: false,
      code: 'missing_timestamp',
    });
    expect(verify({ timestampHeader: 'abc' })).toEqual({ ok: false, code: 'malformed_timestamp' });
  });

  it('enforces the 5 minute window in both directions', () => {
    const old = String(Math.floor(nowMs / 1000) - LIMITS.signatureToleranceSeconds - 1);
    const future = String(Math.floor(nowMs / 1000) + LIMITS.signatureToleranceSeconds + 1);
    const edge = String(Math.floor(nowMs / 1000) - LIMITS.signatureToleranceSeconds);
    expect(
      verify({ timestampHeader: old, signatureHeader: signPayload(secret, old, body) }),
    ).toEqual({
      ok: false,
      code: 'timestamp_out_of_window',
    });
    expect(
      verify({ timestampHeader: future, signatureHeader: signPayload(secret, future, body) }),
    ).toEqual({
      ok: false,
      code: 'timestamp_out_of_window',
    });
    expect(
      verify({ timestampHeader: edge, signatureHeader: signPayload(secret, edge, body) }),
    ).toEqual({ ok: true });
  });

  it('does not accept a replayed signature with a refreshed timestamp', () => {
    const sig = signPayload(secret, ts, body);
    const newTs = String(Number(ts) + 10);
    expect(verify({ timestampHeader: newTs, signatureHeader: sig })).toEqual({
      ok: false,
      code: 'signature_mismatch',
    });
  });
});

describe('envelope', () => {
  const base = {
    id: deterministicUuid('a'),
    type: 'demo.counter.increment' as const,
    runId: deterministicUuid('run'),
    aggregateId: 'counter-demo',
    sequence: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: { delta: 1 },
  };

  it('serializes deterministically and hashes the exact string', () => {
    const raw = serializeEnvelope(base);
    expect(serializeEnvelope({ ...base })).toBe(raw);
    expect(sha256Hex(raw)).toBe(sha256Hex(Buffer.from(raw)));
    expect(JSON.parse(raw)).toEqual(base);
  });

  it('validates data per event type', () => {
    expect(envelopeSchema.safeParse(base).success).toBe(true);
    expect(envelopeSchema.safeParse({ ...base, data: { delta: 1.5 } }).success).toBe(false);
    expect(
      envelopeSchema.safeParse({ ...base, type: 'demo.order.snapshot', data: { delta: 1 } })
        .success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        ...base,
        type: 'demo.order.snapshot',
        data: { orderId: 'o1', status: 'paid', items: [{ sku: 's', qty: 1 }], totalCents: 100 },
      }).success,
    ).toBe(true);
  });

  it('deterministicUuid is stable and v4-shaped', () => {
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'));
    expect(deterministicUuid('x')).not.toBe(deterministicUuid('y'));
    expect(deterministicUuid('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('exposes lowercase header names', () => {
    for (const v of Object.values(HEADERS)) expect(v).toBe(v.toLowerCase());
  });
});
