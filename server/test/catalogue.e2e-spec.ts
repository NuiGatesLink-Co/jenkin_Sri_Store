import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { seedCategories } from '../src/db/seed.js';
import { CAT_PALETTE, catColor } from '../src/products/categories.service.js';
import { SEARCH_EXPRESSION } from '../src/products/products.service.js';
import {
  accessToken,
  createTestApp,
  resetTenant,
  seedProduct,
  type TenantFixture,
} from './support/fixture.js';

/**
 * #16 `p4.1` — products, categories, suppliers, stock adjustment, movements.
 *
 * The cases under "Dart parity" are `frontend/test/products_repository_test.dart`
 * one for one, replayed at the HTTP seam. Where the Dart repository answers `null` /
 * `false` / a silent no-op, the server answers the HTTP equivalent (400 / 409 / 404)
 * and the assertion is that nothing was written.
 */
const TENANT = '16161616-1616-4616-8616-161616161616';
const OTHER = '16161616-2626-4626-8626-262626262626';

describe('catalogue (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let cache: Redis;
  let fixture: TenantFixture;
  let manager: string;
  let cashier: string;
  let otherManager: string;
  let key = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token = manager) => ({ Authorization: `Bearer ${token}` });
  const idem = () => `catalogue-${++key}-${Date.now()}`;

  const post = (path: string, body: unknown, token = manager, k = idem()) =>
    http()
      .post(`/api/v1${path}`)
      .set(auth(token))
      .set('Idempotency-Key', k)
      .send(body as object);
  const patch = (path: string, body: unknown, token = manager) =>
    http()
      .patch(`/api/v1${path}`)
      .set(auth(token))
      .set('Idempotency-Key', idem())
      .send(body as object);
  const del = (path: string, token = manager) =>
    http()
      .delete(`/api/v1${path}`)
      .set(auth(token))
      .set('Idempotency-Key', idem());
  const get = (path: string, token = manager) =>
    http().get(`/api/v1${path}`).set(auth(token));

  const stockOf = async (id: string, tenant = TENANT) =>
    (
      await admin.query(
        `SELECT stock FROM products WHERE tenant_id = $1::uuid AND id = $2`,
        [tenant, id],
      )
    )[0]?.stock as number | undefined;
  const movementCount = async () =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM movements WHERE tenant_id = $1::uuid`,
        [TENANT],
      )
    )[0].n as number;
  const liveCount = async () =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1::uuid AND deleted_at IS NULL`,
        [TENANT],
      )
    )[0].n as number;

  const newProduct = (over: Record<string, unknown> = {}) => ({
    partNo: 'NEW-001',
    name: 'New Part',
    nameTH: 'ของใหม่',
    category: 'ไฟฟ้า',
    brand: 'Acme',
    price: '100.00',
    cost: '50.00',
    stock: 5,
    minStock: 1,
    ...over,
  });

  beforeAll(async () => {
    ({ app, admin, cache } = await createTestApp());
  });

  beforeEach(async () => {
    fixture = await resetTenant(admin, TENANT, { cache });
    const other = await resetTenant(admin, OTHER, { cache });
    const token = (
      tenantId: string,
      f: TenantFixture,
      role: 'manager' | 'cashier',
    ) =>
      accessToken({
        tenantId,
        userId: f.userId,
        role,
        deviceId: f.backofficeDeviceId,
        deviceRole: 'backoffice',
      });
    manager = token(TENANT, fixture, 'manager');
    cashier = token(TENANT, fixture, 'cashier');
    otherManager = token(OTHER, other, 'manager');

    // The Dart seed rows the parity cases name: p1 stock 48, p2, p8 stock 5.
    await seedProduct(admin, TENANT, {
      id: 'p1',
      partNo: 'HN-15412-KVB',
      name: 'Oil Filter',
      nameTH: 'กรองน้ำมันเครื่อง',
      price: 150,
      cost: 90,
      stock: 48,
      category: 'เครื่องยนต์',
    });
    await seedProduct(admin, TENANT, {
      id: 'p2',
      partNo: 'NGK-BR8ES-11',
      name: 'Spark Plug',
      nameTH: 'หัวเทียน',
      price: 120,
      cost: 70,
      stock: 30,
      category: 'ไฟฟ้า',
    });
    await seedProduct(admin, TENANT, {
      id: 'p8',
      partNo: 'BRK-PAD-F',
      name: 'Front Brake Pad',
      nameTH: 'ผ้าเบรกหน้า',
      price: 850,
      cost: 500,
      stock: 5,
      category: 'เบรก',
    });
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT);
    await resetTenant(admin, OTHER);
    await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [TENANT, OTHER],
    ]);
    await app.close();
  });

  describe('Dart parity — products_repository_test.dart', () => {
    it('getAll returns the seeded products, each with a category', async () => {
      const res = await get('/products');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
      expect(
        res.body.data.every((p: { category: string }) => p.category !== ''),
      ).toBe(true);
      expect(res.body.data[0].price).toBe('150.00');
    });

    it('add with a fresh partNo inserts and assigns a p-prefixed id', async () => {
      const res = await post('/products', newProduct({ id: 'IGNORED' }));
      expect(res.status).toBe(201);
      expect(res.body.data.partNo).toBe('NEW-001');
      expect(res.body.data.id.startsWith('p')).toBe(true);
      expect(res.body.data.id).not.toBe('IGNORED');
      expect(res.body.data).toMatchObject({
        price: '100.00',
        cost: '50.00',
        stock: 5,
        minStock: 1,
      });
      expect(await liveCount()).toBe(4);
    });

    it('add trims the partNo before storing', async () => {
      const res = await post(
        '/products',
        newProduct({ partNo: '  PAD-001  ' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.partNo).toBe('PAD-001');
    });

    it('add with blank partNo is refused and inserts nothing', async () => {
      const res = await post('/products', newProduct({ partNo: '   ' }));
      expect(res.status).toBe(400);
      expect(await liveCount()).toBe(3);
    });

    it('add with duplicate partNo (case-insensitive) is refused', async () => {
      const res = await post(
        '/products',
        newProduct({ partNo: 'hn-15412-kvb' }),
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'DUPLICATE_PART_NO',
        message: 'รหัสอะไหล่นี้มีอยู่แล้ว',
      });
      expect(await liveCount()).toBe(3);
    });

    it('update to a colliding partNo (another product) is refused', async () => {
      const res = await patch('/products/p2', { partNo: 'HN-15412-KVB' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_PART_NO');
      expect((await get('/products/p2')).body.data.partNo).toBe('NGK-BR8ES-11');
    });

    it('update keeping the same partNo on the same product succeeds', async () => {
      const res = await patch('/products/p1', {
        partNo: 'HN-15412-KVB',
        name: 'Renamed',
      });
      expect(res.status).toBe(200);
      expect((await get('/products/p1')).body.data.name).toBe('Renamed');
    });

    it('update with a non-colliding partNo succeeds and applies the patch', async () => {
      const res = await patch('/products/p1', { partNo: 'HN-99999-XYZ' });
      expect(res.status).toBe(200);
      expect((await get('/products/p1')).body.data.partNo).toBe('HN-99999-XYZ');
    });

    it('delete removes the product', async () => {
      expect((await del('/products/p1')).status).toBe(200);
      expect((await get('/products/p1')).status).toBe(404);
      expect((await get('/products')).body.data).toHaveLength(2);
    });

    it('adjustStock positive delta adds stock and writes a movement', async () => {
      const res = await post('/products/p1/adjust-stock', {
        delta: 5,
        type: 'adjustment-in',
        note: 'restock',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.stockAfter).toBe(53);
      expect(res.body.data.product.stock).toBe(53);
      expect((await get('/products/p1')).body.data.stock).toBe(53);

      const moves = await get('/movements');
      expect(moves.body.data).toHaveLength(1);
      expect(moves.body.data[0]).toMatchObject({
        productId: 'p1',
        delta: 5,
        type: 'adjustment-in',
        note: 'restock',
        stockAfter: 53,
      });
    });

    it('adjustStock below zero CLAMPS to 0 and writes exactly one movement with stockAfter 0', async () => {
      const res = await post('/products/p8/adjust-stock', {
        delta: -10,
        type: 'adjustment-out',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.stockAfter).toBe(0);
      expect(await stockOf('p8')).toBe(0);

      const moves = await admin.query(
        `SELECT product_id, delta, stock_after, type, ref_id FROM movements WHERE tenant_id = $1::uuid`,
        [TENANT],
      );
      expect(moves).toEqual([
        // raw delta preserved beside the clamped value, as the Dart repository writes it
        {
          product_id: 'p8',
          delta: -10,
          stock_after: 0,
          type: 'adjustment-out',
          ref_id: null,
        },
      ]);

      const audit = await admin.query(
        `SELECT action, entity_id, user_id, device_id, before, after FROM audit_log
          WHERE tenant_id = $1::uuid`,
        [TENANT],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'stock.adjust',
        entity_id: 'p8',
        user_id: fixture.userId,
        device_id: fixture.backofficeDeviceId,
        before: { stock: 5 },
        after: { stock: 0, delta: -10, type: 'adjustment-out' },
      });
    });

    it('adjustStock on a missing product writes no movement', async () => {
      const res = await post('/products/nope/adjust-stock', {
        delta: 5,
        type: 'adjustment-in',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect(await movementCount()).toBe(0);
    });

    it('getCategories returns the seeded categories in palette order', async () => {
      // Empty table: the Dart repository's seed fallback.
      const fallback = await get('/categories');
      expect(fallback.body.data.map((c: { name: string }) => c.name)).toEqual([
        'เครื่องยนต์',
        'ไฟฟ้า',
        'น้ำมัน',
        'เบรก',
        'ตัวถัง',
      ]);
      await seedCategories(admin, TENANT);
      const seeded = await get('/categories');
      expect(seeded.body.data.map((c: { name: string }) => c.name)).toEqual([
        'เครื่องยนต์',
        'ไฟฟ้า',
        'น้ำมัน',
        'เบรก',
        'ตัวถัง',
      ]);
    });

    it('addCategory appends; blank is refused and duplicate is ignored', async () => {
      await seedCategories(admin, TENANT);
      expect((await post('/categories', { name: '  ช่วงล่าง  ' })).status).toBe(
        201,
      );
      let cats = (await get('/categories')).body.data as { name: string }[];
      expect(cats[cats.length - 1].name).toBe('ช่วงล่าง');

      expect((await post('/categories', { name: '   ' })).status).toBe(400);
      const dup = await post('/categories', { name: 'ช่วงล่าง' });
      expect(dup.status).toBe(201);
      cats = (await get('/categories')).body.data;
      expect(cats.filter((c) => c.name === 'ช่วงล่าง')).toHaveLength(1);
      expect(cats).toHaveLength(6);
    });

    it('deleteCategory removes a category', async () => {
      await seedCategories(admin, TENANT);
      expect(
        (await del(`/categories/${encodeURIComponent('ไฟฟ้า')}`)).status,
      ).toBe(200);
      const cats = (await get('/categories')).body.data as { name: string }[];
      expect(cats.map((c) => c.name)).not.toContain('ไฟฟ้า');
    });

    it('catColor is stable by category index (palette order)', async () => {
      await seedCategories(admin, TENANT);
      const cats = (await get('/categories')).body.data as {
        name: string;
        color: string;
      }[];
      cats.forEach((c, i) =>
        expect(c.color).toBe(CAT_PALETTE[i % CAT_PALETTE.length]),
      );
      expect(cats.find((c) => c.name === 'เครื่องยนต์')?.color).toBe('#1E4A80');
      expect(cats.find((c) => c.name === 'ไฟฟ้า')?.color).toBe('#C04E10');
    });
  });

  describe('acceptance criteria', () => {
    it('AC1: deleting a product on old bills returns 200 and hides it from every list', async () => {
      await admin.query(
        `INSERT INTO sales (tenant_id, id, receipt_no, subtotal, discount, total, payment_method)
         VALUES ($1::uuid, 'old-bill', 'RC-OLD', 850, 0, 850, 'เงินสด')`,
        [TENANT],
      );
      await admin.query(
        `INSERT INTO sale_items (tenant_id, sale_id, line_no, product_id, part_no, name, qty, price)
         VALUES ($1::uuid, 'old-bill', 1, 'p8', 'BRK-PAD-F', 'Front Brake Pad', 1, 850)`,
        [TENANT],
      );
      await admin.query(
        `INSERT INTO movements (tenant_id, id, product_id, part_no, name, delta, type, stock_after, ref_id)
         VALUES ($1::uuid, 'mv-old', 'p8', 'BRK-PAD-F', 'Front Brake Pad', -1, 'sale', 5, 'old-bill')`,
        [TENANT],
      );
      await admin.query(
        `UPDATE products SET updated_at = '2026-01-01T00:00:00Z' WHERE tenant_id = $1::uuid`,
        [TENANT],
      );
      const cursor = '2026-06-01T00:00:00.000Z';

      const res = await del('/products/p8');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: 'p8', deleted: true });
      // Repeating it is still 200 — the hard-delete contract.
      expect((await del('/products/p8')).status).toBe(200);

      const ids = (r: request.Response) =>
        r.body.data.map((p: { id: string }) => p.id);
      expect(ids(await get('/products'))).not.toContain('p8');
      expect(
        ids(await get(`/products?search=${encodeURIComponent('เบรก')}`)),
      ).toEqual([]);
      expect(ids(await get('/products?partNo=BRK-PAD-F'))).toEqual([]);
      expect(
        ids(await get(`/products?category=${encodeURIComponent('เบรก')}`)),
      ).toEqual([]);
      expect((await get('/products/p8')).status).toBe(404);
      expect((await get('/products/p8/suppliers')).body.data).toEqual([]);

      // The sync read is the one place the tombstone is visible (01_DATABASE.md §10).
      const sync = await get(
        `/products?updatedSince=${encodeURIComponent(cursor)}`,
      );
      expect(sync.body.data).toHaveLength(1);
      expect(sync.body.data[0]).toMatchObject({
        id: 'p8',
        deletedAt: expect.any(String),
      });

      const history = await admin.query(
        `SELECT (SELECT count(*)::int FROM sale_items WHERE tenant_id = $1::uuid AND product_id = 'p8') AS items,
                (SELECT count(*)::int FROM movements  WHERE tenant_id = $1::uuid AND product_id = 'p8') AS moves`,
        [TENANT],
      );
      expect(history[0]).toEqual({ items: 1, moves: 1 });
      // The reused part number is free once the old product is a tombstone.
      expect(
        (await post('/products', newProduct({ partNo: 'BRK-PAD-F' }))).status,
      ).toBe(201);
    });

    it('AC2: ?partNo= returns exactly one product; a near match returns none', async () => {
      await seedProduct(admin, TENANT, {
        id: 'bp1',
        partNo: 'BP-1',
        name: 'Pad 1',
        price: 1,
        cost: 1,
        stock: 1,
      });
      await seedProduct(admin, TENANT, {
        id: 'bp10',
        partNo: 'BP-10',
        name: 'Pad 10',
        price: 1,
        cost: 1,
        stock: 1,
      });

      const one = await get('/products?partNo=BP-1');
      expect(one.status).toBe(200);
      expect(one.body.data.map((p: { id: string }) => p.id)).toEqual(['bp1']);
      expect(one.body.meta.total).toBe(1);
      expect((await get('/products?partNo=BP')).body.data).toEqual([]);
      // Filters are part of the cache key: the unfiltered page is not a partNo answer.
      expect((await get('/products')).body.data.length).toBeGreaterThan(1);
      expect(
        (await get('/products?partNo=BP-10')).body.data.map(
          (p: { id: string }) => p.id,
        ),
      ).toEqual(['bp10']);
    });

    it('AC2: ?search= finds a Thai term mid-name, through the trigram index', async () => {
      const res = await get(`/products?search=${encodeURIComponent('เบรก')}`);
      expect(res.body.data.map((p: { id: string }) => p.id)).toEqual(['p8']);
      // Case-insensitive on the Latin fields, as the screens' toLowerCase() filter.
      expect(
        (await get('/products?search=spark')).body.data.map(
          (p: { id: string }) => p.id,
        ),
      ).toEqual(['p2']);
      // A LIKE wildcard in the term is a literal.
      expect((await get('/products?search=%25')).body.data).toEqual([]);

      // The predicate alone, with sequential scans priced out: the only way left to
      // answer it is an index on the identical expression. (With the tenant filter
      // added, a table this small is cheaper through `idx_products_cat`, which proves
      // nothing either way.)
      const plan = await admin.transaction(async (tx) => {
        await tx.query(`SET LOCAL enable_seqscan = off`);
        return (await tx.query(
          `EXPLAIN SELECT id FROM products
            WHERE ${SEARCH_EXPRESSION} LIKE lower($1) ESCAPE '\\'`,
          ['%เบรก%'],
        )) as { 'QUERY PLAN': string }[];
      });
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        'idx_products_search',
      );
    });

    it('AC3: deleting a category leaves its products intact and still rendering a colour', async () => {
      await seedCategories(admin, TENANT);
      expect(
        (await del(`/categories/${encodeURIComponent('เบรก')}`)).status,
      ).toBe(200);

      const pad = await get('/products/p8');
      expect(pad.status).toBe(200);
      expect(pad.body.data.category).toBe('เบรก');
      const names = (
        (await get('/categories')).body.data as { name: string }[]
      ).map((c) => c.name);
      expect(names).not.toContain('เบรก');
      // The orphan renders through the hash fallback, deterministically, from the palette.
      const color = catColor('เบรก', names);
      expect(CAT_PALETTE).toContain(color);
      expect(catColor('เบรก', names)).toBe(color);
    });

    it('AC4: an adjustment below zero clamps and writes exactly one movement (see parity case)', async () => {
      const res = await post('/products/p1/adjust-stock', {
        delta: -1000,
        type: 'adjustment-out',
        note: 'นับใหม่',
      });
      expect(res.body.data.movement).toMatchObject({
        delta: -1000,
        stockAfter: 0,
        note: 'นับใหม่',
      });
      expect(await stockOf('p1')).toBe(0);
      expect(await movementCount()).toBe(1);
    });
  });

  describe('stock adjustment input and replay', () => {
    it('refuses invalid bodies with 400 before touching stock', async () => {
      for (const body of [
        {},
        { delta: '5', type: 'adjustment-in' },
        { delta: 2.5, type: 'adjustment-in' },
        { delta: 5, type: 'adjust' },
        { delta: 5, type: 'receive' },
        { delta: 5, type: 'adjustment-out' },
        { delta: -5, type: 'adjustment-in' },
        { delta: 2_147_483_647, type: 'adjustment-in' },
      ]) {
        const res = await post('/products/p1/adjust-stock', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const noKey = await http()
        .post('/api/v1/products/p1/adjust-stock')
        .set(auth())
        .send({ delta: 1, type: 'adjustment-in' });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(await stockOf('p1')).toBe(48);
      expect(await movementCount()).toBe(0);
    });

    it('replays a repeated Idempotency-Key without moving stock twice', async () => {
      const k = idem();
      const body = { delta: -3, type: 'adjustment-out', note: 'แตก' };
      const first = await post('/products/p1/adjust-stock', body, manager, k);
      const second = await post('/products/p1/adjust-stock', body, manager, k);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data).toEqual(first.body.data);
      expect(await stockOf('p1')).toBe(45);
      expect(await movementCount()).toBe(1);

      const reused = await post(
        '/products/p1/adjust-stock',
        { ...body, delta: -4 },
        manager,
        k,
      );
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await stockOf('p1')).toBe(45);
    });

    it('a soft-deleted product cannot be adjusted', async () => {
      await del('/products/p1');
      expect(
        (
          await post('/products/p1/adjust-stock', {
            delta: 1,
            type: 'adjustment-in',
          })
        ).status,
      ).toBe(404);
      expect(await movementCount()).toBe(0);
    });

    it('invalidates the cached product list after the adjustment commits', async () => {
      await get('/products');
      const hit = await get('/products');
      expect(hit.headers['x-cache']).toBe('HIT');
      await post('/products/p1/adjust-stock', {
        delta: 2,
        type: 'adjustment-in',
      });
      const after = await get('/products');
      expect(after.headers['x-cache']).toBe('MISS');
      expect(
        after.body.data.find((p: { id: string }) => p.id === 'p1').stock,
      ).toBe(50);
    });
  });

  describe('reads for the client cache (#55)', () => {
    it('?updatedSince= returns only changed rows, oldest change first, tombstones included', async () => {
      await admin.query(
        `UPDATE products SET updated_at = '2026-01-01T00:00:00Z' WHERE tenant_id = $1::uuid`,
        [TENANT],
      );
      const cursor = '2026-06-01T00:00:00.000Z';
      await patch('/products/p2', { name: 'Spark Plug v2' });
      await del('/products/p1');

      const res = await get(
        `/products?updatedSince=${encodeURIComponent(cursor)}`,
      );
      expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([
        'p2',
        'p1',
      ]);
      expect(res.body.data[1].deletedAt).not.toBeNull();
      expect(res.body.meta.total).toBe(2);
      expect((await get('/products?updatedSince=not-a-date')).status).toBe(400);
    });

    it('PATCH ignores stock and bumps updatedAt', async () => {
      const before = (await get('/products/p1')).body.data;
      const res = await patch('/products/p1', { stock: 999, price: '155.50' });
      expect(res.status).toBe(200);
      expect(res.body.data.stock).toBe(48);
      expect(res.body.data.price).toBe('155.50');
      expect(Date.parse(res.body.data.updatedAt)).toBeGreaterThan(
        Date.parse(before.updatedAt),
      );
      expect((await patch('/products/missing', { name: 'x' })).status).toBe(
        404,
      );
    });
  });

  describe('suppliers and movements', () => {
    it('creates, lists, patches and hard-deletes a product supplier', async () => {
      const created = await post('/suppliers', {
        productId: 'p1',
        name: 'ร้านส่งอะไหล่',
        unitCost: '85.00',
        freight: 5,
        id: 'client-id',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;
      expect(id.startsWith('sup')).toBe(true);
      expect(created.body.data).toMatchObject({
        productId: 'p1',
        unitCost: '85.00',
        freight: '5.00',
      });

      expect((await get('/products/p1/suppliers')).body.data).toHaveLength(1);
      const patched = await patch(`/suppliers/${id}`, { unitCost: '80.00' });
      expect(patched.status).toBe(200);
      expect(patched.body.data.unitCost).toBe('80.00');

      expect((await del(`/suppliers/${id}`)).status).toBe(200);
      expect((await get('/products/p1/suppliers')).body.data).toEqual([]);
      expect((await patch(`/suppliers/${id}`, { name: 'gone' })).status).toBe(
        404,
      );
    });

    it('refuses a supplier for an unknown or deleted product with 404, and bad money with 400', async () => {
      expect(
        (
          await post('/suppliers', {
            productId: 'nope',
            name: 'x',
            unitCost: '1.00',
          })
        ).status,
      ).toBe(404);
      await del('/products/p2');
      expect(
        (
          await post('/suppliers', {
            productId: 'p2',
            name: 'x',
            unitCost: '1.00',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post('/suppliers', {
            productId: 'p1',
            name: 'x',
            unitCost: '-1.00',
          })
        ).status,
      ).toBe(400);
      expect(
        (await post('/suppliers', { productId: 'p1', name: 'x' })).status,
      ).toBe(400);
    });

    it('GET /movements filters by product and date range, newest first', async () => {
      await post('/products/p1/adjust-stock', {
        delta: 1,
        type: 'adjustment-in',
      });
      await post('/products/p2/adjust-stock', {
        delta: 2,
        type: 'adjustment-in',
      });
      await post('/products/p1/adjust-stock', {
        delta: 3,
        type: 'adjustment-in',
      });

      const p1 = await get('/movements?productId=p1');
      expect(p1.body.data.map((m: { delta: number }) => m.delta)).toEqual([
        3, 1,
      ]);
      expect(p1.body.meta.total).toBe(2);
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect(
        (await get(`/movements?from=${encodeURIComponent(future)}`)).body.data,
      ).toEqual([]);
      expect(
        (await get(`/movements?to=${encodeURIComponent(future)}&limit=1`)).body
          .meta.total,
      ).toBe(3);
      expect((await get('/movements?from=yesterday')).status).toBe(400);
    });
  });

  describe('access', () => {
    it('refuses every catalogue write to a cashier and allows the reads', async () => {
      const refusals = [
        await post('/products', newProduct(), cashier),
        await patch('/products/p1', { name: 'x' }, cashier),
        await del('/products/p1', cashier),
        await post(
          '/products/p1/adjust-stock',
          { delta: 1, type: 'adjustment-in' },
          cashier,
        ),
        await post('/categories', { name: 'x' }, cashier),
        await del('/categories/x', cashier),
        await post(
          '/suppliers',
          { productId: 'p1', name: 'x', unitCost: '1.00' },
          cashier,
        ),
      ];
      for (const r of refusals) {
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('FORBIDDEN');
      }
      expect(await stockOf('p1')).toBe(48);
      expect(await liveCount()).toBe(3);
      expect(await movementCount()).toBe(0);

      for (const path of [
        '/products',
        '/products/p1',
        '/categories',
        '/products/p1/suppliers',
        '/movements',
      ]) {
        expect((await get(path, cashier)).status, path).toBe(200);
      }
      expect((await http().get('/api/v1/categories')).status).toBe(401);
    });

    it("another tenant's manager sees and changes nothing (RLS)", async () => {
      await post('/suppliers', {
        productId: 'p1',
        name: 'sup',
        unitCost: '1.00',
      });
      await post('/products/p1/adjust-stock', {
        delta: 1,
        type: 'adjustment-in',
      });
      await seedCategories(admin, TENANT);

      expect((await get('/products', otherManager)).body.data).toEqual([]);
      expect(
        (await get('/products?partNo=HN-15412-KVB', otherManager)).body.data,
      ).toEqual([]);
      expect((await get('/products/p1', otherManager)).status).toBe(404);
      expect(
        (await get('/products/p1/suppliers', otherManager)).body.data,
      ).toEqual([]);
      expect((await get('/movements', otherManager)).body.data).toEqual([]);
      // No categories of its own, so the seed fallback — not tenant A's rows.
      expect((await get('/categories', otherManager)).body.data).toHaveLength(
        5,
      );

      expect(
        (await patch('/products/p1', { name: 'hijack' }, otherManager)).status,
      ).toBe(404);
      expect(
        (
          await post(
            '/products/p1/adjust-stock',
            { delta: -40, type: 'adjustment-out' },
            otherManager,
          )
        ).status,
      ).toBe(404);
      expect((await del('/products/p1', otherManager)).status).toBe(200);
      expect(
        (
          await post(
            '/suppliers',
            { productId: 'p1', name: 'x', unitCost: '1.00' },
            otherManager,
          )
        ).status,
      ).toBe(404);

      const row = await admin.query(
        `SELECT name, stock, deleted_at FROM products WHERE tenant_id = $1::uuid AND id = 'p1'`,
        [TENANT],
      );
      expect(row[0]).toEqual({
        name: 'Oil Filter',
        stock: 49,
        deleted_at: null,
      });
      // The other tenant may reuse the part number: uniqueness is per tenant.
      expect(
        (
          await post(
            '/products',
            newProduct({ partNo: 'HN-15412-KVB' }),
            otherManager,
          )
        ).status,
      ).toBe(201);
    });
  });
});
