import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDEM_CLEANUP_INTERVAL_MS,
  IDEM_CLEANUP_SCHEDULER_ID,
  JOB_IDEM_CLEANUP,
  QUEUE_MAINTENANCE,
} from '../src/queue/queue.constants.js';
import { QueueProcessorsModule } from '../src/queue/queue.module.js';
import { JobSchedulerService } from '../src/queue/job-scheduler.service.js';
import { createTestApp, type TestApp } from './support/fixture.js';

/**
 * #182: nothing scheduled the global `idem.cleanup` job (#169's fan-out deletes real rows,
 * proved by the two-tenant case in `worker-jobs.e2e-spec.ts`, but only once something enqueues
 * it). This proves the repeatable scheduler itself, against real BullMQ/Redis: it registers on
 * boot under a stable id, and re-registering — a restart, or a second worker replica booting —
 * upserts the same schedule instead of adding a second one.
 */
describe('#182: idem.cleanup job scheduler (e2e)', () => {
  let fixture: TestApp;
  let maintenanceQueue: Queue;

  beforeAll(async () => {
    // QueueProcessorsModule is where JobSchedulerService lives (the worker side of the app;
    // AppModule alone never registers it — see server/README.md *Idempotency*).
    fixture = await createTestApp([QueueProcessorsModule]);
    maintenanceQueue = fixture.app.get<Queue>(getQueueToken(QUEUE_MAINTENANCE));
    // `every` (no cron pattern) schedules against epoch-aligned hour boundaries (BullMQ
    // `getNextMillis`), so the first run can land anywhere from ~0ms to ~1h out depending on
    // wall-clock time — pause the queue so this test never races the real worker picking that
    // job up mid-assertion.
    await maintenanceQueue.pause();
  });

  afterAll(async () => {
    // Leave no global schedule behind for the next e2e file / run to trip over.
    await maintenanceQueue.removeJobScheduler(IDEM_CLEANUP_SCHEDULER_ID);
    await maintenanceQueue.resume();
    await fixture.app.close();
  });

  it('registers on boot with the documented cadence and job name', async () => {
    const scheduler = await maintenanceQueue.getJobScheduler(IDEM_CLEANUP_SCHEDULER_ID);

    expect(scheduler).toBeDefined();
    expect(scheduler?.name).toBe(JOB_IDEM_CLEANUP);
    expect(scheduler?.every).toBe(IDEM_CLEANUP_INTERVAL_MS);
  });

  it('a second registration (restart, or another worker replica) upserts the same id, not a duplicate', async () => {
    const scheduler = fixture.app.get(JobSchedulerService);

    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await maintenanceQueue.getJobSchedulers();
    const idemSchedulers = schedulers.filter((s) => s.key === IDEM_CLEANUP_SCHEDULER_ID);
    expect(idemSchedulers).toHaveLength(1);
    expect(idemSchedulers[0]?.every).toBe(IDEM_CLEANUP_INTERVAL_MS);
  });
});
