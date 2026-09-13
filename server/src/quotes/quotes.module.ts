import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller.js';
import { QueueModule } from '../queue/queue.module.js';

@Module({
  imports: [QueueModule],
  controllers: [QuotesController],
  exports: [],
})
export class QuotesModule {}
