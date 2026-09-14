import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [SettingsModule],
  controllers: [BootstrapController],
  providers: [BootstrapService],
  exports: [BootstrapService],
})
export class BootstrapModule {}
