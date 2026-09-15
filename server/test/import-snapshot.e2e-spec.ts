import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { signJwt } from '../src/common/jwt.js';
import { hashPassword } from '../src/common/password.js';
import { APP_CONFIG, type AppConfig } from '../src/config/config.js';
import { generateSyntheticSnapshot } from './fixtures/synthetic-snapshot.js';
import { accessToken, clearTenantCache, createTestApp, TENANT_TABLES_DEPTH_FIRST } from './support/fixture.js';
import { checkSnapshotInvariants, reconcileImport, snapshotShifts } from './support/snapshot-checks.js';

/**
 * #185 — a shop snapshot through the tenant import path and `01_DATABASE.md §9`, end to end:
 * provision the tenant with `POST /platform/tenants` (step 1), pre-flight the file (step 2),
 * `POST /platform/tenants/:id/import` it over HTTP (steps 3–4), then the six checks (step 5),
 * and finally prove the tenant is usable: the imported drawer is archived and visible, the
 * closing report reads it, and a first new bill takes number 0001 against the imported stock.
 *
 * By default the snapshot is the synthetic one (`test/fixtures/synthetic-snapshot.ts`). For the
 * shop's real file — never committed — run only this file:
 *
 *   SNAPSHOT_FILE=/path/backup.json KEEP_TENANT=1 RECONCILE_OUT=/tmp/evidence.json \
 *     corepack pnpm test:e2e test/import-snapshot.e2e-spec.ts
 *
 * `KEEP_TENANT=1` leaves the imported tenant in place as the demo tenant. `RECONCILE_OUT` writes
 * the evidence with counts and totals only — no customer/mechanic codes, no document numbers.
 */
const REAL_FILE = process.env.SNAPSHOT_FILE;
const KEEP = process.env.KEEP_TENANT === '1';
const REPORT = process.env.RECONCILE_OUT;

type Json = Record<string, any>;

describe('tenant import of a shop snapshot through the 01 §9 checklist (#185)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let cache: Redis;
  let adminId: string;
  let adminToken: string;
  const tenants: string[] = [];

  beforeAll(async () => {
    ({ app, admin, cache } = await createTestApp());
    const config = app.get<AppConfig>(APP_CONFIG);
    adminId = randomUUID();
    await admin.query(
      `INSERT INTO platform_admins (id, username, password_hash, display_name, is_active)
       VALUES ($1, $2, $3, 'Import Admin', true)`,
      [adminId, `import-admin-${adminId.slice(0, 8)}`, await hashPassword('import-secret-185')],
    );
    adminToken = signJwt(
      { iss: 'srisurart-pos', aud: 'platform', sub: adminId, username: `import-admin-${adminId.slice(0, 8)}` },
      config.jwtPlatformSecret,
    );
  });

  afterAll(async () => {
    if (!KEEP) {
      for (const tid of tenants) {
        await clearTenantCache(cache, tid);
        for (const table of TENANT_TABLES_DEPTH_FIRST) {
          await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, [tid]);
        }
        await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [tid]);
      }
      await admin.query(`DELETE FROM audit_log WHERE platform_admin_id = $1`, [adminId]);
      await admin.query(`DELETE FROM platform_admins WHERE id = $1`, [adminId]);
    }
    await cache?.del(`pa:${adminId}:exists`);
    await app?.close();
  });

  /** §9 step 1: the tenant, its owner and its first device come from provisioning, never SQL. */
  const provision = async (): Promise<string> => {
    const code = `import-${randomUUID().slice(0, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, shopName: 'ร้านสาธิตนำเข้าข้อมูล', shopNameEn: 'Import Demo', plan: 'demo', ownerUsername: `owner-${code}`, ownerPassword: 'import-owner-185' });
    expect(res.status).toBe(201);
    tenants.push(res.body.data.tenantId);
    return res.body.data.tenantId as string;
  };

  const importFile = (tenantId: string, snapshot: Json) =>
    request(app.getHttpServer())
      .post(`/api/v1/platform/tenants/${tenantId}/import`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(snapshot);

  const count = async (tenantId: string, table: string) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]))[0].n);

  // `realistic` carries what a real Drift file does: history naming hard-deleted products,
  // customers and mechanics, which the import turns into tombstones (#238).
  const PROFILES = REAL_FILE ? ['SNAPSHOT_FILE'] : ['clean', 'realistic'];

  it.each(PROFILES)('imports the %s snapshot and passes all six post-import checks', async (profile) => {
    const label = REAL_FILE ? 'SNAPSHOT_FILE' : `synthetic full/${profile}`;
    const snapshot: Json = REAL_FILE
      ? JSON.parse(readFileSync(REAL_FILE, 'utf8'))
      : generateSyntheticSnapshot({ scale: 'full', profile: profile as 'clean' | 'realistic' });
    const report = (extra: Json) =>
      REPORT && writeFileSync(REAL_FILE ? REPORT : REPORT.replace(/(\.json)?$/, `.${profile}.json`), JSON.stringify(Object.assign(evidence, extra), null, 2));
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    const evidence: Json = { snapshot: label, bytes };

    // §9 step 2: pre-flight on the JSON alone. A violation stops the run — §9 says stop and
    // decide, never import and hope. (The console output may name documents; the report does not.)
    const preflight = checkSnapshotInvariants(snapshot);
    console.info(`snapshot ${label}: ${(bytes / 1024).toFixed(0)} KiB`, preflight);
    report({ preflight: { violations: preflight.violations.length, orphans: preflight.orphans, tombstones: preflight.tombstones } });
    expect(preflight.violations).toEqual([]);
    if (profile === 'realistic') expect(preflight.tombstones.products + preflight.tombstones.customers + preflight.tombstones.mechanics).toBeGreaterThan(0);

    const tenantId = await provision();
    const started = Date.now();
    const res = await importFile(tenantId, snapshot);
    const importMs = Date.now() - started;
    console.info(`import answered ${res.status} in ${importMs} ms`, res.status >= 400 ? res.body : '');
    report({ importStatus: res.status, importMs, tenantId: KEEP ? tenantId : undefined });
    expect(res.status).toBe(201);
    const { products, customers, mechanics } = preflight.tombstones;
    expect(res.body.data.tombstones).toEqual({ products, customers, mechanics });
    // Audited inside the import transaction, with the count per table.
    const [audit] = await admin.query(
      `SELECT after FROM audit_log WHERE tenant_id = $1 AND action = 'platform.tenant.import'`,
      [tenantId],
    );
    expect(audit.after).toEqual({ tombstones: { products, customers, mechanics } });

    // §9 step 5.
    const rows = await reconcileImport(admin, tenantId, snapshot);
    console.table(rows);
    if (KEEP) console.info(`demo tenant kept: ${tenantId}`);
    report({ rows });
    expect(rows.filter((r) => !r.ok)).toEqual([]);

    // The file's drawer is archived, never left active with no device (review of #244):
    // nothing is "current", and the newest shift with its entries is in history.
    const latest = [...snapshotShifts(snapshot)].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];
    const owner = accessToken({ tenantId, role: 'owner' });
    const get = (path: string, token = owner) => request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    expect(await count(tenantId, 'shifts')).toBeGreaterThan(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM shifts WHERE tenant_id = $1 AND is_active`, [tenantId]))[0].n).toBe(0);
    expect((await get('/shifts/current')).body.data ?? null).toBeNull();
    const history = await get('/shifts/history?page=1&limit=1');
    expect(history.status).toBe(200);
    const newest = history.body.data[0];
    expect(newest.dateStr ?? newest.date_str).toBe(latest.date);
    expect(newest.entries).toHaveLength((latest.entries ?? []).length);

    // The same drawer, as the closing report reads it. Imported bills carry no `shift_id`
    // (the file does not link them), so only starting cash and entries count.
    const closing = await get(`/reports/closing?shiftId=${encodeURIComponent(newest.id)}`);
    expect(closing.status).toBe(200);
    report({ closing: closing.body.data });
    const entries = (latest.entries ?? []) as Json[];
    const flow = (type: string) => entries.filter((e) => e.type === type).reduce((t, e) => t + Math.round(Number(e.amount) * 100), 0);
    expect(closing.body.data.startingCash).toBe(Number(latest.startingCash).toFixed(2));
    expect(Math.round(Number(closing.body.data.drawerIn) * 100)).toBe(flow('in'));
    expect(Math.round(Number(closing.body.data.drawerOut) * 100)).toBe(flow('out'));

    // Document numbers: the import seeds no counter, and no imported number is in the
    // server's format, so the first new bill is 0001 and cannot collide.
    expect(await count(tenantId, 'doc_counters')).toBe(0);
    const serverFormat = /^(RC|CN|PO|QT|CP)\d{2}-\d{4}-\d{2}-\d{4}$/;
    const numbers = [
      ...(snapshot.sa_sales ?? []).map((x: Json) => x.receiptNo),
      ...(snapshot.sa_returns ?? []).map((x: Json) => x.cnNo),
      ...(snapshot.sa_pos ?? []).map((x: Json) => x.poNo),
      ...(snapshot.sa_quotes ?? []).map((x: Json) => x.quoteNo),
      ...(snapshot.sa_credit_payments ?? []).map((x: Json) => x.receiptNo),
    ];
    expect(numbers.filter((n) => serverFormat.test(String(n)))).toEqual([]);

    if (REAL_FILE) return; // never ring a bill into the shop's own data
    const pos = accessToken({ tenantId, role: 'cashier', deviceId: 'pos1', deviceRole: 'pos' });
    const opened = await request(app.getHttpServer())
      .post('/api/v1/shifts/open')
      .set('Authorization', `Bearer ${pos}`)
      .set('Idempotency-Key', `k-open-${randomUUID()}`)
      .send({ startingCash: '1000.00' });
    expect(opened.status).toBe(200);
    // The imported drawer stays in history once a device has opened its own.
    expect((await get('/shifts/current')).body.data.id).toBe(opened.body.data.id);
    expect((await get('/shifts/history?page=1&limit=1')).body.data[0].id).toBe(newest.id);

    const [product] = await admin.query(
      `SELECT id, part_no, name, price, stock FROM products WHERE tenant_id = $1 AND stock > 0 ORDER BY id LIMIT 1`,
      [tenantId],
    );
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${pos}`)
      .set('Idempotency-Key', `k-sale-${randomUUID()}`)
      .send({
        id: `s-after-import-${randomUUID()}`, subtotal: product.price, discount: '0.00', total: product.price,
        paymentMethod: 'เงินสด', items: [{ lineNo: 1, productId: product.id, name: product.name, qty: 1, price: product.price }],
      });
    expect(sale.status).toBe(201);
    expect(sale.body.data.receiptNo).toMatch(/^RC01-\d{4}-\d{2}-0001$/);
    const [after] = await admin.query(`SELECT stock FROM products WHERE tenant_id = $1 AND id = $2`, [tenantId, product.id]);
    expect(after.stock).toBe(product.stock - 1);
    report({ firstBillAfterImport: { numberedFrom0001: true, stockBefore: product.stock, stockAfter: after.stock } });
  });

  it.skipIf(Boolean(REAL_FILE))('rolls the whole shop back when one row is refused (§9 step 4)', async () => {
    const snapshot = generateSyntheticSnapshot({ scale: 'small', profile: 'clean' }) as Json;
    // One of the last rows the import writes (after every sale, return, PO and movement):
    // a drawer entry Postgres refuses (CHECK amount > 0).
    const history = snapshot.sa_shift_history as Json[];
    history[history.length - 1].entries.push({ id: 'de-poison', type: 'out', amount: 0, note: 'poison', createdAt: '2026-05-01T03:00:00.000Z' });

    const tenantId = await provision();
    const res = await importFile(tenantId, snapshot);
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const table of ['products', 'sales', 'customers', 'mechanics', 'shifts', 'drawer_entries', 'movements']) {
      expect({ table, n: await count(tenantId, table) }).toEqual({ table, n: 0 });
    }
  });

  it.skipIf(Boolean(REAL_FILE))('refuses a second import into a tenant that already has bills', async () => {
    const snapshot = generateSyntheticSnapshot({ scale: 'small', profile: 'clean' });
    const tenantId = await provision();
    expect((await importFile(tenantId, snapshot)).status).toBe(201);
    const again = await importFile(tenantId, snapshot);
    expect(again.status).toBe(409);
  });
});
