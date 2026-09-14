import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { QuotesController } from './quotes.controller.js';
import { QuotesService } from './quotes.service.js';

@Module({
  imports: [QueueModule, DocumentsModule, IdempotencyModule, SalesModule],
  controllers: [QuotesController],
  providers: [QuotesService],
  exports: [],
})
export class QuotesModule {}
