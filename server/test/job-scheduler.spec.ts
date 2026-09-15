import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { JobSchedulerService } from '../src/queue/job-scheduler.service.js';
import {
  IDEM_CLEANUP_INTERVAL_MS,
  IDEM_CLEANUP_SCHEDULER_ID,
  JOB_IDEM_CLEANUP,
} from '../src/queue/queue.constants.js';

const logger = pino({ level: 'silent' });

describe('JobSchedulerService (#182, unit)', () => {
  it('registers the idem.cleanup repeatable job with a stable scheduler id on bootstrap', async () => {
    const mockQueue = { upsertJobScheduler: vi.fn().mockResolvedValue({ id: 'next-job' }) };
    const service = new JobSchedulerService(mockQueue as any, logger);

    await service.onApplicationBootstrap();

    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      IDEM_CLEANUP_SCHEDULER_ID,
      { every: IDEM_CLEANUP_INTERVAL_MS },
      { name: JOB_IDEM_CLEANUP, data: expect.objectContaining({ correlationId: expect.any(String) }) },
    );
  });

  it('re-registering (a restart, or a second worker replica) upserts the same id rather than adding a second one', async () => {
    const mockQueue = { upsertJobScheduler: vi.fn().mockResolvedValue({ id: 'next-job' }) };
    const service = new JobSchedulerService(mockQueue as any, logger);

    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    const ids = mockQueue.upsertJobScheduler.mock.calls.map((call) => call[0]);
    expect(ids).toEqual([IDEM_CLEANUP_SCHEDULER_ID, IDEM_CLEANUP_SCHEDULER_ID]);
  });
});
