import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:dev-only-postgres@127.0.0.1:5432/pos';

export async function verifyIntegrity() {
  const envPath = path.resolve(__dirname, 'k6-env.json');
  if (!fs.existsSync(envPath)) {
    console.error('❌ k6-env.json not found. Run "pnpm k6:setup" first.');
    process.exit(1);
  }

  const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const tenantId = envData.tenantId;
  const productId = envData.productId ?? 'p12';
  const initialStock = Number(envData.initialStock ?? 50);

  const pool = new pg.Pool({ connectionString: DB_URL });
  const client = await pool.connect();

  try {
    console.log('\n================================================================');
    console.log('🔍 DATA INTEGRITY PROOF (Assignment & Rubric Verification)');
    console.log('================================================================');
    console.log(`Tenant ID:     ${tenantId}`);
    console.log(`Target Product: ${productId}`);
    console.log(`Initial Stock:  ${initialStock}`);
    console.log(`Timestamp:      ${new Date().toISOString()}`);
    console.log('----------------------------------------------------------------');

    // 1. Current stock of p12
    const productRes = await client.query(
      `SELECT id, part_no, name, stock FROM products WHERE tenant_id = $1::uuid AND id = $2`,
      [tenantId, productId],
    );
    if (productRes.rows.length === 0) {
      throw new Error(`Product ${productId} not found in database!`);
    }
    const currentStock = Number(productRes.rows[0].stock);

    // 2. Total sold quantity in sale_items
    const soldRes = await client.query(
      `SELECT COALESCE(SUM(si.qty), 0)::int as sold_qty,
              COUNT(DISTINCT si.sale_id)::int as total_bills,
              COUNT(*)::int as total_lines
       FROM sale_items si
       JOIN sales s ON s.tenant_id = si.tenant_id AND s.id = si.sale_id
       WHERE si.tenant_id = $1::uuid AND si.product_id = $2 AND s.voided_at IS NULL`,
      [tenantId, productId],
    );
    const soldQty = Number(soldRes.rows[0].sold_qty);
    const totalBills = Number(soldRes.rows[0].total_bills);

    // 3. Movement deltas
    const movRes = await client.query(
      `SELECT COALESCE(SUM(delta), 0)::int as movement_delta
       FROM movements
       WHERE tenant_id = $1::uuid AND product_id = $2`,
      [tenantId, productId],
    );
    const movementDelta = Number(movRes.rows[0].movement_delta);

    // 4. Check duplicate receipt numbers across tenant
    const receiptsRes = await client.query(
      `SELECT COUNT(*)::int as total_sales,
              COUNT(DISTINCT receipt_no)::int as distinct_receipts
       FROM sales
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const totalSales = Number(receiptsRes.rows[0].total_sales);
    const distinctReceipts = Number(receiptsRes.rows[0].distinct_receipts);
    const noDuplicateReceipts = totalSales === distinctReceipts;

    // 5. Compute Assertions
    const expectedStock = initialStock - soldQty;
    const stockEquationMatch = currentStock === expectedStock;
    const stockNonNegative = currentStock >= 0;

    console.log(`Current Stock in DB:              ${currentStock}`);
    console.log(`Total Units Sold (sale_items):   ${soldQty} (across ${totalBills} bills)`);
    console.log(`Expected Stock (initial - sold):  ${expectedStock}`);
    console.log(`Stock Movements Balance (delta):  ${movementDelta}`);
    console.log(`Total Sales / Unique Receipts:    ${totalSales} / ${distinctReceipts}`);
    console.log('----------------------------------------------------------------');
    console.log('RESULTS & INVARIANT VERIFICATION:');
    console.log(`1. Stock Invariant (stock == initial - sold): ${stockEquationMatch ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`2. Stock Non-Negative (stock >= 0):           ${stockNonNegative ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`3. Receipt Uniqueness (no duplicates):        ${noDuplicateReceipts ? '✅ PASS' : '❌ FAIL'}`);
    console.log('================================================================');

    const allPassed = stockEquationMatch && stockNonNegative && noDuplicateReceipts;
    if (allPassed) {
      console.log('🎉 ALL INTEGRITY CHECKS PASSED PERFECTLY!\n');
    } else {
      console.error('❌ INTEGRITY CHECK FAILED!\n');
      process.exitCode = 1;
    }

    return {
      allPassed,
      productId,
      initialStock,
      currentStock,
      soldQty,
      totalBills,
      totalSales,
      distinctReceipts,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('verify-integrity.ts')) {
  verifyIntegrity()
    .then((res) => {
      if (!res.allPassed) process.exit(1);
    })
    .catch((err) => {
      console.error('Error during verification:', err);
      process.exit(1);
    });
}
