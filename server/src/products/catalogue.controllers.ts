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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Paginated, pageParams } from '../common/paginated.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import { isoDate } from '../people/people.dto.js';
import type { MovementOut } from '../sales/sales.service.js';
import {
  parseCategoryCreate,
  parseSupplierCreate,
  parseSupplierPatch,
  requireManager,
  type AuthenticatedRequest,
} from './catalogue.dto.js';
import { CategoriesService, type Category } from './categories.service.js';
import { MovementsService } from './movements.service.js';
import { SuppliersService, type Supplier } from './suppliers.service.js';

@Controller('categories')
@UseGuards(TenantGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(): Promise<Category[]> {
    return this.categories.list();
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Category> {
    requireManager(req);
    return this.categories.create(parseCategoryCreate(body).name);
  }

  @Delete(':name')
  @UseInterceptors(IdempotencyInterceptor)
  delete(
    @Param('name') name: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ name: string; deleted: true }> {
    requireManager(req);
    return this.categories.delete(name);
  }
}

/** Reads live on `GET /products/:id/suppliers` (ProductsController). */
@Controller('suppliers')
@UseGuards(TenantGuard)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Supplier> {
    requireManager(req);
    return this.suppliers.create(parseSupplierCreate(body));
  }

  @Patch(':id')
  @UseInterceptors(IdempotencyInterceptor)
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Supplier> {
    requireManager(req);
    return this.suppliers.update(id, parseSupplierPatch(body));
  }

  @Delete(':id')
  @UseInterceptors(IdempotencyInterceptor)
  delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; deleted: true }> {
    requireManager(req);
    return this.suppliers.delete(id);
  }
}

@Controller('movements')
@UseGuards(TenantGuard)
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Get()
  async list(
    @Query('productId') productId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<Paginated<MovementOut>> {
    const parsed = pageParams(page, limit);
    const result = await this.movements.list({
      productId: productId || undefined,
      from: isoDate(from, 'from'),
      to: isoDate(to, 'to'),
      ...parsed,
    });
    return new Paginated(result.items, { total: result.total, ...parsed });
  }
}
