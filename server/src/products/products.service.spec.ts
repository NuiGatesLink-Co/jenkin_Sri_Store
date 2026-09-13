import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProductsService } from './products.service.js';
import * as requestContext from '../common/request-context.js';

describe('ProductsService Caching & Reads', () => {
  let service: ProductsService;
  let redisMock: any;
  let managerMock: any;

  beforeEach(() => {
    redisMock = {
      get: vi.fn(),
      set: vi.fn(),
      keys: vi.fn(),
      del: vi.fn(),
    };
    managerMock = {
      query: vi.fn(),
    };

    vi.spyOn(requestContext, 'currentRequestContext').mockReturnValue({
      tenantId: '00000000-0000-4000-8000-000000000001',
      manager: managerMock,
    } as any);

    service = new ProductsService(redisMock);
  });

  it('returns cached products when cache hits (fromCache: true)', async () => {
    const cachedData = {
      items: [
        {
          id: 'p1',
          partNo: 'BP-1',
          name: 'Brake Pad',
          nameTH: 'ผ้าเบรก',
          category: 'เบรก',
          brand: 'TEST',
          price: 500,
          cost: 300,
          stock: 10,
          minStock: 2,
          compat: null,
          updatedAt: '2026-09-13T00:00:00.000Z',
          deletedAt: null,
        },
      ],
      total: 1,
    };
    redisMock.get.mockResolvedValue(JSON.stringify(cachedData));

    const result = await service.list({ page: 1, limit: 10 });

    expect(result.fromCache).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('p1');
    expect(managerMock.query).not.toHaveBeenCalled();
  });

  it('queries database and populates Redis cache on cache miss (fromCache: false)', async () => {
    redisMock.get.mockResolvedValue(null);
    managerMock.query
      .mockResolvedValueOnce([{ n: 1 }]) // totals
      .mockResolvedValueOnce([
        {
          id: 'p12',
          part_no: 'OIL-1',
          name: 'Engine Oil',
          name_th: 'น้ำมันเครื่อง',
          category: 'น้ำมัน',
          brand: 'TEST',
          price: '800.00',
          cost: '500.00',
          stock: 50,
          min_stock: 5,
          compat: null,
          updated_at: new Date('2026-09-13T00:00:00.000Z'),
          deleted_at: null,
        },
      ]); // rows

    const result = await service.list({ page: 1, limit: 10 });

    expect(result.fromCache).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('p12');
    expect(result.items[0].price).toBe(800);
    expect(result.items[0].cost).toBe(500);
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringContaining('t:00000000-0000-4000-8000-000000000001:products:list:'),
      expect.any(String),
      'EX',
      60,
    );
  });

  it('invalidates cache properly', async () => {
    redisMock.keys.mockResolvedValue(['t:t1:products:list:1', 't:t1:products:item:p1']);
    await service.invalidateCache('t1');
    expect(redisMock.del).toHaveBeenCalledWith('t:t1:products:list:1', 't:t1:products:item:p1');
  });
});
