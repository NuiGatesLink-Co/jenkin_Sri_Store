import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { ParkedSalesController } from './parked-sales.controller.js';
import { ParkedSalesService } from './parked-sales.service.js';

@Module({
  imports: [IdempotencyModule],
  controllers: [ParkedSalesController],
  providers: [ParkedSalesService],
})
export class ParkedSalesModule {}
