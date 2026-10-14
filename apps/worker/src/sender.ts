import type { SendResult } from '@lab/shared';

export interface SendRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxPreviewBytes: number;
}

export interface SendObservation {
  result: SendResult;
  httpStatus: number | null;
  responsePreview: string | null;
  durationMs: number;
}

/**
 * Reads at most `maxBytes` of the response body and cancels the stream afterwards, so a huge
 * response is never downloaded just to be truncated.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function networkCode(err: unknown): string {
  const e = err as { cause?: { code?: string }; code?: string } | undefined;
  return (e?.cause?.code ?? e?.code ?? 'unknown').toString().toLowerCase();
}

/**
 * Sends one webhook attempt. Redirects are never followed (a 3xx is surfaced and treated as a
 * permanent failure) so an allowlisted receiver cannot bounce us to an arbitrary host.
 */
export async function sendWebhook(req: SendRequest): Promise<SendObservation> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      signal,
    });
    let preview: string | null = null;
    try {
      preview = await readBounded(res.body, req.maxPreviewBytes);
    } catch {
      preview = null; // status is already known; a broken body read does not change the verdict
    }
    return {
      result: { kind: 'http', status: res.status, retryAfterHeader: res.headers.get('retry-after') },
      httpStatus: res.status,
      responsePreview: preview,
      durationMs: elapsed(),
    };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
      return { result: { kind: 'timeout' }, httpStatus: null, responsePreview: null, durationMs: elapsed() };
    }
    return {
      result: { kind: 'network_error', code: networkCode(err) },
      httpStatus: null,
      responsePreview: null,
      durationMs: elapsed(),
    };
  }
}
