export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /secret|authorization|signature|token|password/i;

export type LogFields = Record<string, unknown> & {
  runId?: string | null;
  eventId?: string | null;
  deliveryId?: string | null;
  attemptId?: string | null;
  correlationId?: string | null;
};

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** Minimal JSON-lines logger. Sensitive keys are redacted; headers are never logged wholesale. */
export function createLogger(
  service: string,
  level: LogLevel = 'info',
  base: LogFields = {},
): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      service,
      msg,
      ...redact({ ...base, ...(fields ?? {}) }),
    });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger(service, level, { ...base, ...b }),
  };
}

export function errorFields(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) return { error: err.message, stack: err.stack };
  return { error: String(err) };
}
