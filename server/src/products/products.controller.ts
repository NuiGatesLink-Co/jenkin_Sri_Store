import {
  BadRequestException,
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
    @Query('afterId') afterId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Paginated<Product>> {
    const parsed = pageParams(page, limit);
    const since = isoDate(updatedSince, 'updatedSince');
    // The sync read is keyset-paged: a reader follows `meta.nextCursor` and always asks
    // for the first page after it. An OFFSET under a fixed cursor drifts as soon as a
    // row is edited mid-pass, so it is refused rather than half-supported.
    if (afterId && !since) {
      throw new BadRequestException('afterId requires updatedSince');
    }
    if (since && parsed.page > 1) {
      throw new BadRequestException(
        'updatedSince is keyset-paged: follow meta.nextCursor instead of page',
      );
    }
    // A scan that read nothing names no product. Treating a blank `?partNo=` as "no
    // filter" would answer with catalogue page 1, and a scanner taking `data[0]` would
    // put an arbitrary part on the bill.
    if (partNo !== undefined && partNo.trim() === '') {
      return new Paginated([], { total: 0, ...parsed });
    }
    const result = await this.products.list({
      search: search || undefined,
      partNo: partNo?.trim() || undefined,
      category: category || undefined,
      updatedSince: since,
      afterId: afterId || undefined,
      ...parsed,
    });
    res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    return new Paginated(result.items, {
      total: result.total,
      ...parsed,
      nextCursor: result.nextCursor,
    });
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
