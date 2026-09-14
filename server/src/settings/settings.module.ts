import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({
  imports: [IdempotencyModule],
  controllers: [SettingsController, BootstrapController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
