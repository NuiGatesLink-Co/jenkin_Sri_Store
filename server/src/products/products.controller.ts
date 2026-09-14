import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Paginated, pageParams } from '../common/paginated.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import { isoDate } from '../people/people.dto.js';
import {
  parseProductCreate,
  parseProductPatch,
  parseStockAdjustment,
  requireManager,
  type AuthenticatedRequest,
} from './catalogue.dto.js';
import {
  ProductsService,
  type Product,
  type StockAdjustmentResult,
} from './products.service.js';
import { SuppliersService, type Supplier } from './suppliers.service.js';

@Controller('products')
@UseGuards(TenantGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly suppliers: SuppliersService,
  ) {}

  @Get()
  async list(
    @Query('search') search: string | undefined,
    @Query('partNo') partNo: string | undefined,
    @Query('category') category: string | undefined,
    @Query('updatedSince') updatedSince: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Paginated<Product>> {
    const parsed = pageParams(page, limit);
    const result = await this.products.list({
      search: search || undefined,
      partNo: partNo || undefined,
      category: category || undefined,
      updatedSince: isoDate(updatedSince, 'updatedSince'),
      ...parsed,
    });
    res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    return new Paginated(result.items, { total: result.total, ...parsed });
  }

  @Get(':id/suppliers')
  suppliersOf(@Param('id') id: string): Promise<Supplier[]> {
    return this.suppliers.listForProduct(id);
  }

  @Get(':id')
  async byId(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Product> {
    const result = await this.products.byId(id);
    res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    return result.product;
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Product> {
    requireManager(req);
    return this.products.create(parseProductCreate(body));
  }

  @Patch(':id')
  @UseInterceptors(IdempotencyInterceptor)
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Product> {
    requireManager(req);
    return this.products.update(id, parseProductPatch(body));
  }

  @Delete(':id')
  @UseInterceptors(IdempotencyInterceptor)
  delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; deleted: true }> {
    requireManager(req);
    return this.products.delete(id);
  }

  /** Both device roles (02_API_SCREENS.md §4): stock, unlike the drawer, is not `pos`-only. */
  @Post(':id/adjust-stock')
  @UseInterceptors(IdempotencyInterceptor)
  adjustStock(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<StockAdjustmentResult> {
    requireManager(req);
    return this.products.adjustStock(id, parseStockAdjustment(body), {
      userId: req.user.userId,
      deviceId: req.user.deviceId,
    });
  }
}
