import type { BackoffStrategy } from 'bullmq';

/**
 * Exponential backoff with full jitter strategy for BullMQ.
 *
 * Course deck omits jitter; without it, failed jobs collide on retries.
 * Delay formula: delay = min(maxDelay, baseDelay * 2^(attemptsMade - 1))
 * Jittered delay: uniform random in [0, delay].
 */
export function calculateJitterBackoff(
  attemptsMade: number,
  baseDelay = 1000,
  maxDelay = 30000,
  randomFn: () => number = Math.random,
): number {
  if (attemptsMade <= 0) return 0;
  const exponent = Math.min(20, attemptsMade - 1);
  const maxForAttempt = Math.min(maxDelay, baseDelay * Math.pow(2, exponent));
  return Math.floor(randomFn() * maxForAttempt);
}

export const JITTER_BACKOFF_STRATEGY = {
  'exponential-jitter': (attemptsMade: number): number => {
    return calculateJitterBackoff(attemptsMade);
  },
};

/**
 * #201: `DEFAULT_JOB_OPTIONS.backoff.type` is `'exponential-jitter'`, which is not one of
 * BullMQ's builtins (`'fixed'` / `'exponential'`). `Backoffs.calculate` (bullmq's
 * classes/backoffs.js) falls back to a worker's `settings.backoffStrategy` for
 * any other type, and throws `Unknown backoff strategy …` if none is registered — observed
 * against real Redis as the failing job staying stuck `active` with `attemptsMade` 0 instead of
 * retrying or failing. This is that `settings.backoffStrategy`: every `@Processor(...)` worker
 * must pass `WORKER_SETTINGS` (below) as its second argument so BullMQ always finds it.
 *
 * Dispatches known custom types to their strategy; any other type is refused explicitly rather
 * than silently defaulting to some delay, which would hide a typo'd `backoff.type` on a future
 * job option the same way this bug hid `'exponential-jitter'`.
 */
export const backoffStrategy: BackoffStrategy = (attemptsMade, type) => {
  const strategy = type && JITTER_BACKOFF_STRATEGY[type as keyof typeof JITTER_BACKOFF_STRATEGY];
  if (!strategy) {
    throw new Error(`Unknown custom backoff strategy: ${type}`);
  }
  return strategy(attemptsMade);
};

/**
 * The `WorkerOptions` fragment every `@Processor(QUEUE_X, …)` must spread in as its second
 * argument. `BullModule.forRootAsync`'s `defaultJobOptions` (queue.module.ts) covers
 * `attempts`/`backoff.type`/etc. per-queue, but BullMQ scopes `settings` per-*Worker*, not
 * per-Queue — there is no single registration point for it, which is how #201 happened. A fifth
 * processor that forgets to spread this in reintroduces the bug for its own queue only;
 * `worker-settings.spec.ts` checks every `@Processor` carries it.
 */
export const WORKER_SETTINGS = { settings: { backoffStrategy } } as const;
