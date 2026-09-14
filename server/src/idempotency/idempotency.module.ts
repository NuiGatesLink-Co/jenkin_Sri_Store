import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Import where a controller calls `IdempotencyService.runIdempotent` (#18 p5.1; explicit
 * since tx.3 #152). `POST /sales` was the first adopter, in #20.
 */
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
