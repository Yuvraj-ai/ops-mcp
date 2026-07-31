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
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS action_log;
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
    idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm succeeds", reconfirm.success === true);

  const orderAfter = await byName.get_order_details.handler({ order_id: "A1023" }) as any;
  check("order status flipped to confirmed", orderAfter.status === "confirmed");

  const shipmentAfter = await byName.get_shipment_status.handler({ order_id: "A1023" }) as any;
  check("shipment record now exists and is pending", shipmentAfter.status === "pending");

  // === Oversell prevention ===
  console.log("\n== Oversell prevention ==");
  const oversellAttempt = await byName.reconfirm_order.handler({
    order_id: "A1024",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440001",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm rejects out-of-stock order (no oversell)", !!oversellAttempt.error);

  const orderAfterReject = await byName.get_order_details.handler({ order_id: "A1024" }) as any;
  check("order status unchanged after rejected reconfirm", orderAfterReject.status === "failed");

  const stockAfter = await byName.check_stock_availability.handler({ sku: "SKU-101", quantity: 1 }) as any;
  check("stock not decremented on rejected oversell", stockAfter.available_qty === 0);

  // === A1024: refund path ===
  console.log("\n== Scenario: A1024 (stock unavailable -> refund path) ==");
  const stock2 = await byName.check_stock_availability.handler({ sku: "SKU-101", quantity: 1 }) as any;
  check("stock is insufficient", stock2.sufficient === false);

  const refund = await byName.issue_refund.handler({
    order_id: "A1024",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440002",
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
    idempotency_key: "550e8400-e29b-41d4-a716-446655440003",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm rejects an already-refunded order", !!rejectRefunded.error);

  const rejectCancelled = await byName.issue_refund.handler({
    order_id: "A1026",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440004",
    amount: 1299,
    reason: "test",
    confirmed_by_operator: true,
  }) as any;
  check("refund rejects an order with no captured payment", !!rejectCancelled.error);

  const rejectDecoy = await byName.reconfirm_order.handler({
    order_id: "A1027",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440005",
    confirmed_by_operator: true,
  }) as any;
  check("reconfirm rejects a non-failed order (decoy)", !!rejectDecoy.error);

  const rejectUnknown = await byName.get_order_details.handler({ order_id: "A9999" }) as any;
  check("lookup on unknown order returns a clear error, not a crash", !!rejectUnknown.error);

  // === Audit log ===
  console.log("\n== Audit log verification ==");
  const auditRows = await pool.query(
    "SELECT order_id, tool_name, success FROM action_log ORDER BY id"
  );
  const reconfirmAudit = auditRows.rows.find(r => r.tool_name === "reconfirm_order" && r.order_id === "A1023");
  check("audit log records reconfirm_order for A1023 as success", reconfirmAudit?.success === true);

  const refundAudit = auditRows.rows.find(r => r.tool_name === "issue_refund" && r.order_id === "A1024");
  check("audit log records issue_refund for A1024 as success", refundAudit?.success === true);

  const rejectedAudit = auditRows.rows.find(r => r.tool_name === "reconfirm_order" && r.order_id === "A1025");
  check("audit log records rejected reconfirm on A1025 as failure", rejectedAudit?.success === false);

  // === Idempotency ===
  console.log("\n== Idempotency verification ==");

  // Use A1004 (confirmed, captured payment) for a successful refund idempotency test
  const idemKey = "550e8400-e29b-41d4-a716-446655440099";
  const firstRefund = await byName.issue_refund.handler({
    order_id: "A1004",
    idempotency_key: idemKey,
    amount: 3499,
    reason: "idempotency test",
    confirmed_by_operator: true,
  }) as any;
  check("first idempotency call succeeds", firstRefund.success === true);

  // Same key — must replay stored result, NOT re-execute (which would fail: A1004 is now "refunded")
  const secondRefund = await byName.issue_refund.handler({
    order_id: "A1004",
    idempotency_key: idemKey,
    amount: 3499,
    reason: "idempotency test",
    confirmed_by_operator: true,
  }) as any;
  check("second call with same key replays result (not re-execution)", secondRefund.success === true);
  check("replayed result matches first call", JSON.stringify(firstRefund) === JSON.stringify(secondRefund));

  // Idempotency keys table should have exactly 1 entry for this key
  const idemCount = await pool.query(
    "SELECT COUNT(*) as count FROM idempotency_keys WHERE key = $1",
    [idemKey]
  );
  check("idempotency key stored once", idemCount.rows[0].count === 1);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

run();
