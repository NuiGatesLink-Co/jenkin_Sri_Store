import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DocNumberService } from '../documents/doc-number.service.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { ProductsModule } from '../products/products.module.js';
import { PurchasingController } from './purchasing.controller.js';
import { PurchasingService } from './purchasing.service.js';

@Module({
  imports: [IdempotencyModule, ProductsModule],
  controllers: [PurchasingController],
  providers: [PurchasingService, DocNumberService, AuditService],
  exports: [PurchasingService],
})
export class PurchasingModule {}
