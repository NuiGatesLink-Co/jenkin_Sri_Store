import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({
  // `ShiftsService.closeForRetirement` runs inside the retirement's transaction (ADR-0004).
  imports: [IdempotencyModule, ShiftsModule],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
