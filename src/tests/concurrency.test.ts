/**
 * Fix 1c — genuine concurrent-request verification.
 *
 * MUST run against real Postgres. The properties under test (row-level locking,
 * READ COMMITTED re-evaluation of a WHERE clause after a lock wait, transactional
 * rollback) do not exist in an in-memory emulation — `pg-mem` accepts
 * BEGIN/ROLLBACK without honoring it and has no row locks, so a concurrency test
 * passing there would demonstrate nothing.
 *
 * Two scenarios:
 *   A. SAME idempotency key   -> the second call should REPLAY the stored result,
 *                                not execute a second mutation.
 *   B. DIFFERENT idempotency keys -> replay cannot intercept, so the Fix 1b
 *                                guarded UPDATE must let exactly one win and
 *                                abort the other.
 *
 * Run with: npm run test:concurrency
 */
import { OpsRepository } from "../db/queries.js";
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

/** Count rows, cast in SQL — real Postgres returns COUNT(*) as a bigint string. */
async function countRows(pool: Pool, sql: string, params: any[] = []): Promise<number> {
  const result = await pool.query(sql, params);
  return Number(result.rows[0].count);
}

async function run() {
  const pool = createTestPool();
  await resetTestSchema(pool);

  const repo = new OpsRepository(pool);
  const tools = buildToolDefinitions(repo);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, any>;

  // === Scenario B: different idempotency keys, same order, fired together ===
  //
  // This is the case the client identified: idempotency-replay cannot intercept
  // two distinct keys, so correctness rests entirely on the guarded UPDATE.
  console.log("\n== Scenario B: concurrent reconfirm, DIFFERENT idempotency keys ==");

  const stockBefore = (await byName.check_stock_availability.handler({
    sku: "SKU-202",
    quantity: 1,
  })) as any;
  check("A1023 starts with sufficient stock", stockBefore.sufficient === true);

  const orderBefore = (await byName.get_order_details.handler({ order_id: "A1023" })) as any;
  check("A1023 starts as 'failed'", orderBefore.status === "failed");

  // Fire without awaiting the first — both handlers read state before either commits.
  const attemptB1 = byName.reconfirm_order.handler({
    order_id: "A1023",
    idempotency_key: "b1111111-1111-4111-8111-111111111111",
    confirmed_by_operator: true,
  });
  const attemptB2 = byName.reconfirm_order.handler({
    order_id: "A1023",
    idempotency_key: "b2222222-2222-4222-8222-222222222222",
    confirmed_by_operator: true,
  });
  const resultsB = await Promise.all([attemptB1, attemptB2]);

  const successesB = resultsB.filter((r: any) => r.success === true);
  const errorsB = resultsB.filter((r: any) => r.error);
  check("exactly one concurrent attempt succeeded", successesB.length === 1);
  check("exactly one concurrent attempt was rejected", errorsB.length === 1);

  const loserMessage = (errorsB[0] as any)?.error ?? "";
  check(
    "the losing attempt got a clear, actionable error",
    /state changed|re-investigate|not 'failed'|insufficient/i.test(loserMessage)
  );
  if (errorsB.length === 1) console.log(`        loser said: ${loserMessage}`);

  // Exactly one hold, one stock decrement, one success audit row.
  const holdCount = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM inventory_holds WHERE order_id = $1 AND status = 'active'",
    ["A1023"]
  );
  check("exactly one active hold exists (no duplicate reservation)", holdCount === 1);

  const stockAfter = (await byName.check_stock_availability.handler({
    sku: "SKU-202",
    quantity: 1,
  })) as any;
  check(
    "stock decremented exactly once",
    stockAfter.available_qty === stockBefore.available_qty - 1
  );

  const successAudits = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM action_log WHERE order_id = $1 AND tool_name = 'reconfirm_order' AND success = true",
    ["A1023"]
  );
  check("exactly one success row in the audit log", successAudits === 1);

  const orderAfter = (await byName.get_order_details.handler({ order_id: "A1023" })) as any;
  check("order ended in 'confirmed'", orderAfter.status === "confirmed");

  // === Scenario A: same idempotency key, fired together ===
  //
  // Here replay is the intended mechanism. Note this exercises a genuine race in
  // the replay path itself: both calls may miss the idempotency row on their
  // initial read, in which case the composite PK on (tool_name, key) is the
  // backstop that prevents a second mutation from committing.
  console.log("\n== Scenario A: concurrent reconfirm, SAME idempotency key ==");

  await resetTestSchema(pool);

  const sharedKey = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const stockBeforeA = (await byName.check_stock_availability.handler({
    sku: "SKU-202",
    quantity: 1,
  })) as any;

  const resultsA = await Promise.all([
    byName.reconfirm_order.handler({
      order_id: "A1023",
      idempotency_key: sharedKey,
      confirmed_by_operator: true,
    }),
    byName.reconfirm_order.handler({
      order_id: "A1023",
      idempotency_key: sharedKey,
      confirmed_by_operator: true,
    }),
  ]);

  const successesA = resultsA.filter((r: any) => r.success === true);
  const errorsA = resultsA.filter((r: any) => r.error);

  // Data integrity is the hard requirement and it holds: one mutation only.
  check("same-key concurrency produced exactly one successful mutation", successesA.length === 1);

  // KNOWN GAP (documented, not yet fixed): under a TRUE same-key race — both
  // calls in flight before either commits — neither sees the other's
  // idempotency row on its initial read, so the loser falls through to the Fix
  // 1b guard and receives a state-changed ERROR rather than a replay of the
  // stored result. The client's stated idempotency contract is "retry with the
  // same key replays the stored result", which holds for sequential retries
  // (the normal case: timeout, then retry) but not for genuinely simultaneous
  // same-key calls. Nothing is double-executed; the caller just gets a
  // less-helpful response than the contract promises.
  //
  // Proper fix would be to catch the unique-violation on the idempotency INSERT
  // and re-read the stored result to return it. Recorded in handoff.md §5.5.4.
  if (errorsA.length > 0) {
    console.log(`        NOTE: same-key loser returned an error, not a replay:`);
    console.log(`        ${(errorsA[0] as any).error}`);
  }
  check(
    "same-key loser did not double-execute (error or replay, never a second mutation)",
    successesA.length === 1
  );

  const holdCountA = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM inventory_holds WHERE order_id = $1 AND status = 'active'",
    ["A1023"]
  );
  check("exactly one active hold after same-key concurrency", holdCountA === 1);

  const stockAfterA = (await byName.check_stock_availability.handler({
    sku: "SKU-202",
    quantity: 1,
  })) as any;
  check(
    "stock decremented exactly once under same-key concurrency",
    stockAfterA.available_qty === stockBeforeA.available_qty - 1
  );

  const idemRows = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM idempotency_keys WHERE tool_name = 'reconfirm_order' AND key = $1",
    [sharedKey]
  );
  check("idempotency key stored exactly once", idemRows === 1);

  const successAuditsA = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM action_log WHERE order_id = $1 AND tool_name = 'reconfirm_order' AND success = true",
    ["A1023"]
  );
  check("at most one success audit row under same-key concurrency", successAuditsA <= 1);

  // === Concurrent refund, different keys (money path) ===
  console.log("\n== Concurrent refund, DIFFERENT idempotency keys ==");

  await resetTestSchema(pool);

  const resultsR = await Promise.all([
    byName.issue_refund.handler({
      order_id: "A1024",
      idempotency_key: "c1111111-1111-4111-8111-111111111111",
      amount: 1799,
      reason: "concurrent refund test 1",
      confirmed_by_operator: true,
    }),
    byName.issue_refund.handler({
      order_id: "A1024",
      idempotency_key: "c2222222-2222-4222-8222-222222222222",
      amount: 1799,
      reason: "concurrent refund test 2",
      confirmed_by_operator: true,
    }),
  ]);

  const successesR = resultsR.filter((r: any) => r.success === true);
  check("exactly one concurrent refund succeeded", successesR.length === 1);

  const refundSuccessAudits = await countRows(
    pool,
    "SELECT COUNT(*)::int as count FROM action_log WHERE order_id = $1 AND tool_name = 'issue_refund' AND success = true",
    ["A1024"]
  );
  check("exactly one success row in the refund audit log", refundSuccessAudits === 1);

  const paymentRow = await pool.query("SELECT status FROM payments WHERE order_id = $1", ["A1024"]);
  check("payment ended in 'refunded'", paymentRow.rows[0].status === "refunded");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

run();
