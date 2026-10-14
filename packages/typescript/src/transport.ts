/**
 * Transport resilience for calls to Orlo: a timeout per attempt, a bounded retry that reuses the
 * request's Idempotency-Key (so the server replays instead of running twice), and a circuit breaker
 * that stops waiting on Orlo after repeated failures.
 */

export class OrloUnavailableError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown = null) {
    super(message);
    this.name = 'OrloUnavailableError';
    this.cause = cause;
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the breaker. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before letting a request through again. Default 30 s. */
  cooldownMs?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}, now: () => number = Date.now) {
    this.threshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = now;
  }

  /** False while open. After the cooldown, requests go through; one more failure reopens it. */
  canRequest(): boolean {
    return this.now() >= this.openUntil;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before the next attempt: Retry-After when the server sends one (capped at 1 s), else linear backoff. */
export function retryDelayMs(response: Response | null, attempt: number, baseMs: number): number {
  const retryAfter = Number(response?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(1_000, retryAfter * 1_000);
  }
  return baseMs * attempt;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' ? 'timed out' : err.message;
  }
  return String(err);
}
