import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller.js';
import { QueueModule } from '../queue/queue.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [QueueModule, AuditModule],
  controllers: [BackupController],
  exports: [],
})
export class BackupModule {}
