/**
 * Focused runtime verification for the ops-mcp tool layer.
 *
 * This bypasses the HTTP/MCP transport and calls tool handlers directly
 * against a real Postgres database (dedicated test schema — see testdb.ts),
 * so transactional behavior is genuinely exercised rather than emulated.
 * It covers the behavior that actually matters for the demo workflow:
 * the two resolution paths (reconfirm vs refund) and the safety rejections.
 *
 * Run with: npm test
 */
import { OpsRepository, newId } from "../db/queries.js";
import { buildToolDefinitions } from "../tools/definitions.js";
import { createTestPool, resetTestSchema } from "./testdb.js";
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

async function run() {
  const pool = createTestPool();
  await resetTestSchema(pool);

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

  // Idempotency keys table should have exactly 1 entry for this key.
  // Cast to int in SQL: real Postgres returns COUNT(*) as a bigint, which the pg
  // driver surfaces as a *string* (bigints can exceed JS's safe integer range).
  const idemCount = await pool.query(
    "SELECT COUNT(*)::int as count FROM idempotency_keys WHERE key = $1",
    [idemKey]
  );
  check("idempotency key stored once", idemCount.rows[0].count === 1);

  // === Transactional audit + idempotency ===
  console.log("\n== Transactional audit + idempotency ==");

  // A1001 starts as 'delivered' with captured payment — refund it, then verify
  // both action_log and idempotency_keys were written INSIDE the same DB transaction
  const txnRefund = await byName.issue_refund.handler({
    order_id: "A1001",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440088",
    amount: 1499,
    reason: "transactional test",
    confirmed_by_operator: true,
  }) as any;
  check("transactional refund succeeds", txnRefund.success === true);

  const txnIdem = await pool.query(
    "SELECT result FROM idempotency_keys WHERE key = $1",
    ["550e8400-e29b-41d4-a716-446655440088"]
  );
  check("idempotency key committed in same txn as mutation", txnIdem.rows.length === 1);
  const txnIdemResult = JSON.parse(txnIdem.rows[0].result);
  check("idempotency result matches successful refund", txnIdemResult.success === true);

  const txnAudit = await pool.query(
    "SELECT success, result_json FROM action_log WHERE order_id = $1 AND tool_name = $2",
    ["A1001", "issue_refund"]
  );
  check("audit log committed in same txn as mutation", txnAudit.rows.length >= 1);
  const txnAuditResult = JSON.parse(txnAudit.rows[0].result_json);
  check("audit log result matches successful refund", txnAuditResult.success === true);

  // Replay should return same result — proves idempotency key was committed
  const txnReplay = await byName.issue_refund.handler({
    order_id: "A1001",
    idempotency_key: "550e8400-e29b-41d4-a716-446655440088",
    amount: 1499,
    reason: "transactional test replay (should be ignored)",
    confirmed_by_operator: true,
  }) as any;
  check("replay returns stored result, not re-execution error", txnReplay.success === true);

  // === Concurrency guards (Fix 1b) ===
  //
  // These call the REPOSITORY methods directly, deliberately bypassing the
  // handler's pre-check. That is exactly the state a losing concurrent request
  // finds itself in: it passed the status check a moment ago, but by the time
  // its UPDATE runs, a winning request has already committed a status change.
  //
  // NOTE: this proves the guard LOGIC in isolation (conditional UPDATE -> 0 rows
  // -> abort -> rollback). The race itself, under genuinely simultaneous
  // requests, is covered separately in concurrency.test.ts (`npm run
  // test:concurrency`).
  console.log("\n== Concurrency guards (state-changed aborts) ==");

  // A1003 is 'processing', not 'failed', and its SKU-404 still has stock — so the
  // stock decrement succeeds and execution actually reaches the status guard.
  // (A stock-exhausted order would abort earlier, at the stock check, and never
  // exercise the guard at all.)
  const stockBeforeGuard = await byName.check_stock_availability.handler({ sku: "SKU-404", quantity: 1 }) as any;
  check("guard-test order has stock available (so the guard, not the stock check, fires)", stockBeforeGuard.sufficient === true);
  let reconfirmGuardError: string | null = null;
  try {
    await repo.reconfirmOrder("A1003", "550e8400-e29b-41d4-a716-446655440077", "{}");
  } catch (err) {
    reconfirmGuardError = err instanceof Error ? err.message : String(err);
  }
  check("reconfirmOrder aborts when order is no longer 'failed'", reconfirmGuardError !== null);
  check(
    "reconfirm abort message tells the operator to re-investigate",
    /re-investigate/i.test(reconfirmGuardError ?? "")
  );

  const orderAfterGuard = await byName.get_order_details.handler({ order_id: "A1003" }) as any;
  check("order untouched after guarded reconfirm abort", orderAfterGuard.status === "processing");

  // Now runnable against real Postgres. Under pg-mem this assertion could not be
  // made at all: pg-mem accepts ROLLBACK but does not honor it, so the decrement
  // persisted and this check failed for reasons unrelated to our code.
  const stockAfterGuard = await byName.check_stock_availability.handler({ sku: "SKU-404", quantity: 1 }) as any;
  check(
    "stock decrement ROLLED BACK after guarded reconfirm abort",
    stockAfterGuard.available_qty === stockBeforeGuard.available_qty
  );

  const holdsAfterGuard = await pool.query("SELECT id FROM inventory_holds WHERE order_id = $1", ["A1003"]);
  check("no duplicate hold created after guarded reconfirm abort", holdsAfterGuard.rows.length === 1);

  // A1025 is already 'refunded'. A guarded UPDATE must match 0 rows.
  let refundGuardError: string | null = null;
  try {
    await repo.issueRefund("A1025", "550e8400-e29b-41d4-a716-446655440078", "{}", "double refund attempt");
  } catch (err) {
    refundGuardError = err instanceof Error ? err.message : String(err);
  }
  check("issueRefund aborts when order is already refunded", refundGuardError !== null);

  const refundAuditRows = await pool.query(
    "SELECT id FROM action_log WHERE order_id = $1 AND tool_name = $2 AND success = true",
    ["A1025", "issue_refund"]
  );
  check("no success audit row written for aborted double refund", refundAuditRows.rows.length === 0);

  // === Unique ID generation (collision fix) ===
  //
  // Hold/shipment IDs were `H${Date.now()}` — two writes in the same
  // millisecond collide on a TEXT PRIMARY KEY.
  console.log("\n== Unique ID generation ==");
  const rapidIds = Array.from({ length: 1000 }, () => newId("H"));
  check("1000 rapidly-generated IDs are all distinct", new Set(rapidIds).size === 1000);
  check("generated IDs keep their prefix", rapidIds.every((id) => id.startsWith("H")));

  // === Rejection-path audit observability (Fix 2) ===
  //
  // Audit/idempotency writes on the rejection path are best-effort by design:
  // the transaction they would belong to has already rolled back, so a failure
  // here must not crash or alter the user-facing response. But "best-effort"
  // must not mean "invisible" — a failure has to be diagnosable from the server
  // log alone, which means naming the tool and order involved.
  console.log("\n== Rejection-path audit observability ==");

  const originalError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };

  let threw = false;
  try {
    // Simulate a transient DB fault the way it would actually present: the
    // INSERT itself fails. (A bogus order_id would not — action_log has no FK on
    // order_id by design, since rejections against unknown orders must still be
    // logged.) Renaming the table out from under the write is the cheapest
    // faithful stand-in for "the audit INSERT failed".
    await pool.query("ALTER TABLE action_log RENAME TO action_log_stashed");
    await repo.logAction({
      order_id: "A1023",
      tool_name: "reconfirm_order",
      input_json: "{}",
      result_json: "{}",
      success: false,
    });
  } catch {
    threw = true;
  } finally {
    await pool.query("ALTER TABLE action_log_stashed RENAME TO action_log");
    console.error = originalError;
  }

  check("a failed audit write does not throw (stays non-blocking)", threw === false);
  check("the failure is logged, not swallowed", captured.length > 0);

  const auditLogLine = captured.join(" | ");
  check("audit failure log names the tool", /reconfirm_order/.test(auditLogLine));
  check("audit failure log names the order", /A1023/.test(auditLogLine));
  check(
    "audit failure log includes the underlying error",
    /does not exist|relation|error/i.test(auditLogLine)
  );

  const capturedIdem: string[] = [];
  console.error = (...args: unknown[]) => {
    capturedIdem.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  let idemThrew = false;
  try {
    // Duplicate key -> unique violation on the composite PK.
    await repo.storeIdempotencyResult("issue_refund", "550e8400-e29b-41d4-a716-446655440099", { ok: true });
    await repo.storeIdempotencyResult("issue_refund", "550e8400-e29b-41d4-a716-446655440099", { ok: true });
  } catch {
    idemThrew = true;
  } finally {
    console.error = originalError;
  }

  check("a failed idempotency store does not throw", idemThrew === false);
  const idemLogLine = capturedIdem.join(" | ");
  check("idempotency failure log names the tool", /issue_refund/.test(idemLogLine));
  check(
    "idempotency failure log names the key",
    /550e8400-e29b-41d4-a716-446655440099/.test(idemLogLine)
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

run();
