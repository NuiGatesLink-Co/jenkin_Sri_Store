import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Paginated, pageParams } from '../common/paginated.js';
import { ProductsService, type Product } from './products.service.js';

function isoDate(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (Number.isNaN(Date.parse(raw))) {
    throw new BadRequestException(`${field} must be an ISO-8601 timestamp`);
  }
  return raw;
}

@Controller('products')
@UseGuards(TenantGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(
    @Query('search') search: string | undefined,
    @Query('category') category: string | undefined,
    @Query('updatedSince') updatedSince: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Paginated<Product>> {
    const parsed = pageParams(page, limit);
    const result = await this.products.list({
      search: search || undefined,
      category: category || undefined,
      updatedSince: isoDate(updatedSince, 'updatedSince'),
      ...parsed,
    });
    res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    return new Paginated(result.items, { total: result.total, ...parsed });
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
}
