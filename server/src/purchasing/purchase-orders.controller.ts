import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DeviceRoleForbiddenException } from '../common/device-role-forbidden.exception.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Paginated, pageParams } from '../common/paginated.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import {
  requireManager,
  type AuthenticatedRequest,
} from '../products/catalogue.dto.js';
import { parsePoCreate, parsePoStatus } from './purchase-orders.dto.js';
import {
  PurchaseOrdersService,
  type PurchaseOrder,
  type ReceiveResult,
} from './purchase-orders.service.js';

/**
 * 02_API_SCREENS.md §3.3 / §4: reads for any role, writes `manager` (owner included),
 * both device roles — receiving stock is back-office work and touches no drawer.
 */
@Controller('purchase-orders')
@UseGuards(TenantGuard)
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<Paginated<PurchaseOrder>> {
    const parsed = pageParams(page, limit);
    const result = await this.orders.list({
      status: parsePoStatus(status),
      ...parsed,
    });
    return new Paginated(result.items, { total: result.total, ...parsed });
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<PurchaseOrder> {
    return this.orders.get(id);
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<PurchaseOrder> {
    requireManager(req);
    const input = parsePoCreate(body);
    // The PO number is issued in the calling device's series (ADR-0007), and the
    // device comes from the token only (ADR-0004).
    if (!req.user.deviceId) throw new DeviceRoleForbiddenException();
    return this.orders.create(input, { deviceId: req.user.deviceId });
  }

  /** The one that matters: transactional, and idempotent by force (§4). */
  @Post(':id/receive')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  receive(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ReceiveResult> {
    requireManager(req);
    return this.orders.receive(id, {
      userId: req.user.userId,
      deviceId: req.user.deviceId,
    });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<PurchaseOrder> {
    requireManager(req);
    return this.orders.cancel(id);
  }

  @Delete(':id')
  @UseInterceptors(IdempotencyInterceptor)
  delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; deleted: true }> {
    requireManager(req);
    return this.orders.delete(id);
  }
}
