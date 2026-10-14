export type DomainErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'payload_too_large'
  | 'run_already_active'
  | 'not_terminal'
  | 'replay_in_progress';

/** Business-level failure; the API layer maps `code` to an HTTP status. */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
