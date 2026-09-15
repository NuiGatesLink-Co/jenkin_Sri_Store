import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { backoffStrategy } from './jitter-backoff.js';
import { SalePostProcessor } from './processors/sale-post.processor.js';
import { InventoryProcessor } from './processors/inventory.processor.js';
import { MaintenanceProcessor } from './processors/maintenance.processor.js';
import { BackupProcessor } from './processors/backup.processor.js';

/**
 * #201: `settings.backoffStrategy` is the one `WorkerOptions` field BullMQ scopes per-Worker,
 * not per-Queue — `BullModule.forRootAsync`'s `defaultJobOptions` (queue.module.ts) covers
 * `attempts`/`backoff.type`/etc. for every queue in one place, but nothing does the same for
 * `settings`, so each `@Processor(...)` decorator has to carry it itself. Without it, BullMQ's
 * `Backoffs.calculate` throws `Unknown backoff strategy exponential-jitter` and the failing job
 * is left stuck `active` instead of retrying or failing (confirmed against real Redis).
 *
 * `@nestjs/bullmq`'s `BullExplorer.registerWorkers` (bull.explorer.js) reads the decorator's
 * second argument via `Reflector.get('bullmq:worker_metadata', ctor)` and spreads it straight
 * into `new Worker(...)`, so reading that same metadata key here checks exactly what the
 * library will pass to BullMQ — not just that the source text mentions the right identifier.
 * A fifth `@Processor` that forgets to pass `WORKER_SETTINGS` (jitter-backoff.ts) fails here
 * instead of silently reintroducing #201 for its own queue.
 */
const WORKER_METADATA = 'bullmq:worker_metadata';

describe('every @Processor registers the #201 backoff strategy', () => {
  const processors: Array<[string, new (...args: never[]) => unknown]> = [
    ['SalePostProcessor', SalePostProcessor],
    ['InventoryProcessor', InventoryProcessor],
    ['MaintenanceProcessor', MaintenanceProcessor],
    ['BackupProcessor', BackupProcessor],
  ];

  it.each(processors)('%s carries settings.backoffStrategy', (_name, ctor) => {
    const options = Reflect.getMetadata(WORKER_METADATA, ctor) as
      | { settings?: { backoffStrategy?: unknown } }
      | undefined;
    expect(options?.settings?.backoffStrategy).toBe(backoffStrategy);
  });

  it('dispatches exponential-jitter to the jitter calculation', () => {
    const delay = backoffStrategy(2, 'exponential-jitter', new Error('x'), undefined);
    // attempt 2: base = 1000 * 2^1 = 2000, jittered uniform in [0, 2000]
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(2000);
  });

  it('refuses an unrecognised custom backoff type explicitly, not with a silent default', () => {
    expect(() =>
      backoffStrategy(1, 'some-unregistered-type', new Error('x'), undefined),
    ).toThrow('Unknown custom backoff strategy: some-unregistered-type');
  });
});
