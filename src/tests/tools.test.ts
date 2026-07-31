/**
 * Focused runtime verification for the ops-mcp tool layer.
 *
 * This bypasses the HTTP/MCP transport and calls tool handlers directly
 * against a fresh Postgres DB, so it runs fast with no server needed.
 * It covers the behavior that actually matters for the demo workflow:
 * the two resolution paths (reconfirm vs refund) and the safety rejections.
 *
 * Run with: npm test
 */
import { newDb } from "pg-mem";
import { initDatabase } from "../db/schema.js";
import { OpsRepository } from "../db/queries.js";
import { buildToolDefinitions } from "../tools/definitions.js";
import { seedDatabase } from "../db/seed.js";
import type { Pool } from "pg";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS shipments;
    DROP TABLE IF EXISTS inventory_holds;
    DROP TABLE IF EXISTS inventory_stock;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS orders;
  `);
  await initDatabase(pool);
  await seedDatabase(pool);
}

async function run() {
  const db = newDb();
  const { Pool: MemPgPool } = db.adapters.createPg();
  const pool = new MemPgPool() as unknown as Pool;
  await resetDatabase(pool);

  const repo = new OpsRepository(pool);
  const tools = buildToolDefinitions(repo);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, any>;

  // === A1023: reconfirm path ===
  console.log("\n== Scenario: A1023 (stock available -> reconfirm path) ==");
  const order1 = await byName.get_order_details.handler({ order_id: "A1023" }) as any;
  check("order starts as failed", order1.status === "failed");

  const pay1 = await byName.get_payment_status.handler({ order_id: "A1023" }) as any;
  check("payment was captured", pay1.status === "captured");

  const hold1 = await byName.get_inventory_hold_status.handler({ order_id: "A1023" }) as any;
  check("hold is expired", hold1.status === "expired");

  const stock1 = await byName.check_stock_availability.handler({ sku: "SKU-202", quantity: 1 }) as any;
  check("stock is sufficient", stock1.sufficient === true);

  const reconfirm = await byName.reconfirm_order.handler({
    order_id: "A1023",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm succeeds", reconfirm.success === true);

  const orderAfter = await byName.get_order_details.handler({ order_id: "A1023" }) as any;
  check("order status flipped to confirmed", orderAfter.status === "confirmed");

  const shipmentAfter = await byName.get_shipment_status.handler({ order_id: "A1023" }) as any;
  check("shipment record now exists and is pending", shipmentAfter.status === "pending");

  // === A1024: refund path ===
  console.log("\n== Scenario: A1024 (stock unavailable -> refund path) ==");
  const stock2 = await byName.check_stock_availability.handler({ sku: "SKU-101", quantity: 1 }) as any;
  check("stock is insufficient", stock2.sufficient === false);

  const refund = await byName.issue_refund.handler({
    order_id: "A1024",
    amount: 1799,
    reason: "Stock unavailable after hold expiry",
    confirmed_by_operator: true,
  }) as any;
  check("refund succeeds", refund.success === true);

  const orderAfterRefund = await byName.get_order_details.handler({ order_id: "A1024" }) as any;
  check("order status flipped to refunded", orderAfterRefund.status === "refunded");

  // === Safety rejections ===
  console.log("\n== Safety: rejection cases ==");
  const rejectRefunded = await byName.reconfirm_order.handler({
    order_id: "A1025",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm rejects an already-refunded order", !!rejectRefunded.error);

  const rejectCancelled = await byName.issue_refund.handler({
    order_id: "A1026",
    amount: 1299,
    reason: "test",
    confirmed_by_operator: true,
  }) as any;
  check("refund rejects an order with no captured payment", !!rejectCancelled.error);

  const rejectDecoy = await byName.reconfirm_order.handler({
    order_id: "A1027",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm rejects a non-failed order (decoy)", !!rejectDecoy.error);

  const rejectUnknown = await byName.get_order_details.handler({ order_id: "A9999" }) as any;
  check("lookup on unknown order returns a clear error, not a crash", !!rejectUnknown.error);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

run();
