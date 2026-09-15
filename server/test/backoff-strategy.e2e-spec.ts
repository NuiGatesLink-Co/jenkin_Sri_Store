import { Queue, Worker, type Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { DEFAULT_JOB_OPTIONS } from '../src/queue/queue.constants.js';
import { WORKER_SETTINGS } from '../src/queue/jitter-backoff.js';

/**
 * #201: `DEFAULT_JOB_OPTIONS.backoff.type` is `'exponential-jitter'` (queue.constants.ts), which
 * is not one of BullMQ's builtin strategies. Against real Redis/BullMQ 6.3.4, a worker with no
 * `settings.backoffStrategy` throws `Unknown backoff strategy exponential-jitter` from inside
 * `moveToFailed`, and the job is left stuck `active` with `attemptsMade` 0 — it neither retries
 * nor fails. `WORKER_SETTINGS` (src/queue/jitter-backoff.ts) is what every `@Processor(...)`
 * worker now passes to fix that (`worker-settings.spec.ts` checks all four carry it).
 *
 * This proves the registration mechanism itself, directly against real Redis, on a private
 * queue (`test-backoff-201`) no other suite touches — the retry/failure mechanics here are
 * BullMQ's own plumbing, not business logic any of the four real processors add, and a synthetic
 * handler that fails only while `job.attemptsMade === 0` is the only way to control exactly
 * which attempt fails without faking tenant/Postgres state a real processor would need.
 *
 * Falsification (see PR description for the recorded red run): commenting out
 * `settings: { backoffStrategy }` inside `WORKER_SETTINGS` reproduces the pre-fix bug exactly —
 * the "retries once and completes" case goes red because the job never leaves `active`.
 */
describe('#201: exponential-jitter backoff is registered on every worker', () => {
  const QUEUE_NAME = 'test-backoff-201';
  const config = loadConfig();
  const url = new URL(config.redisQueueUrl);
  // Same shape `queue.module.ts`'s `BullModule.forRootAsync` factory builds — this suite talks
  // to the real dev redis-queue instance, not a mock.
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  let queue: Queue;
  let worker: Worker | undefined;

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    queue = new Queue(QUEUE_NAME, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    await queue.waitUntilReady();
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    // Leave the private queue clean for the next run: no scheduler, no jobs, not paused.
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('retries a job that fails once (default options) and completes on attempt 2', async () => {
    worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (job.attemptsMade === 0) {
          throw new Error('synthetic failure on first attempt');
        }
        return 'ok';
      },
      { connection, ...WORKER_SETTINGS },
    );
    await worker.waitUntilReady();

    const job = await queue.add('retry-once', {}, { jobId: 'retry-once-201' });

    await waitFor(async () => (await job.getState()) === 'completed');
    const finished = await queue.getJob(job.id!);
    expect(finished?.attemptsMade).toBe(2);
    expect(finished?.returnvalue).toBe('ok');
  });

  it('a job failing every attempt ends failed, not stuck active', async () => {
    worker = new Worker(
      QUEUE_NAME,
      async (): Promise<string> => {
        throw new Error('synthetic permanent failure');
      },
      { connection, ...WORKER_SETTINGS },
    );
    await worker.waitUntilReady();

    const job = await queue.add(
      'always-fails',
      {},
      { jobId: 'always-fails-201', attempts: 2, backoff: DEFAULT_JOB_OPTIONS.backoff },
    );

    await waitFor(async () => (await job.getState()) === 'failed');
    const finished = await queue.getJob(job.id!);
    expect(finished?.attemptsMade).toBe(2);
    expect(finished?.failedReason).toContain('synthetic permanent failure');
  });

  it('leaves the private queue clean afterwards: no scheduler, no active jobs, not paused', async () => {
    expect(await queue.getJobSchedulers()).toEqual([]);
    expect(await queue.getActiveCount()).toBe(0);
    expect(await queue.isPaused()).toBe(false);
  });
});
