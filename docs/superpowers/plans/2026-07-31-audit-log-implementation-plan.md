# Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `action_log` table and audit logging to all write-tool handlers (`reconfirm_order`, `issue_refund`) so every action — successful or rejected — is permanently recorded.

**Architecture:** One new table in `schema.sql`, one `logAction()` method in `OpsRepository`, and a try/catch wrapper with logging in each write-tool handler in `definitions.ts`. Tests use pg-mem and verify both the success path (A1023 reconfirm) and rejection path (A1025 already-refunded) produce audit log rows.

**Tech Stack:** PostgreSQL (via `pg`), pg-mem for tests, existing `OpsRepository` pattern.

---

## Project Context

**Project:** `ops-mcp` — Node.js/TypeScript MCP server for commerce order operations.
**Test framework:** `tsx --test` (native Node test runner), tests call handlers directly against an in-memory pg-mem Postgres instance.
**Test file:** `src/tests/tools.test.ts` — has `resetDatabase()` which drops all tables then calls `initDatabase()` + `seedDatabase()`.
**DB layer:** `OpsRepository` in `src/db/queries.ts` — all SQL lives here, handlers in `definitions.ts` call repo methods.
**Schema:** `src/db/schema.sql` — DDL executed by `initDatabase()`.
**.env:** `dotenv/config` loaded in `server.ts` and `seed.ts`. Connection uses Supabase pooler endpoint with `ssl: { rejectUnauthorized: false }`.

### Files to modify
- `src/db/schema.sql` — add `action_log` table + index
- `src/db/queries.ts` — add `logAction()` method
- `src/tools/definitions.ts` — wrap `reconfirm_order` and `issue_refund` handlers with try/catch + audit logging
- `src/tests/tools.test.ts` — add `DROP TABLE IF EXISTS action_log` to teardown; add 2 test cases
- `docs/handoff.md` — changelog entry

---

### Task 1: Add `action_log` table to schema.sql + update test teardown

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/tests/tools.test.ts:31-41`

- [ ] **Step 1: Append `action_log` table to `schema.sql`**

```sql

CREATE TABLE IF NOT EXISTS action_log (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT,
  tool_name   TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  success     BOOLEAN NOT NULL,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_log_order_id_idx ON action_log(order_id, performed_at DESC);
```

- [ ] **Step 2: Add `DROP TABLE IF EXISTS action_log` to test teardown (before orders, for FK safety)**

In `src/tests/tools.test.ts`, the `resetDatabase` function currently drops tables in this order: `shipments, inventory_holds, inventory_stock, payments, orders`. Insert `action_log` first (it references orders, so drop it before orders):

```typescript
async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
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
```

---

### Task 2: Add `logAction()` method to `OpsRepository`

**File:** Modify: `src/db/queries.ts`

- [ ] **Step 1: Add `logAction` method to `OpsRepository` class**

Insert after the class constructor (after `constructor` line, before `getOrder`):

```typescript
async logAction(params: {
  order_id: string | null;
  tool_name: string;
  input_json: string;
  result_json: string;
  success: boolean;
}): Promise<void> {
  try {
    await this.pool.query(
      `INSERT INTO action_log (order_id, tool_name, input_json, result_json, success)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.order_id, params.tool_name, params.input_json, params.result_json, params.success]
    );
  } catch (err) {
    console.error("Failed to write audit log:", err);
  }
}
```

---

### Task 3: Wrap `reconfirm_order` handler with audit logging

**File:** Modify: `src/tools/definitions.ts` (the `reconfirm_order` handler block)

- [ ] **Step 1: Rewrite the `reconfirm_order` handler with try/catch + logging**

Replace the existing handler in `definitions.ts`:

```typescript
handler: async (input: { order_id: string; confirmed_by_operator: true }) => {
  let result: any;
  try {
    const order = await repo.getOrder(input.order_id);
    if (!order) {
      result = { error: `No order found with ID ${input.order_id}.` };
    } else if (order.status === "refunded" || order.status === "cancelled") {
      result = { error: `Order ${input.order_id} is '${order.status}' and cannot be reconfirmed.` };
    } else if (order.status !== "failed") {
      result = {
        error: `Order ${input.order_id} has status '${order.status}', not 'failed'. Re-investigate before acting.`,
      };
    } else {
      const r = await repo.reconfirmOrder(input.order_id);
      result = {
        success: true,
        new_order_status: "confirmed",
        new_hold_id: r.newHoldId,
        note: "Call get_shipment_status next to verify fulfillment picked this up.",
      };
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  await repo.logAction({
    order_id: input.order_id,
    tool_name: "reconfirm_order",
    input_json: JSON.stringify(input),
    result_json: JSON.stringify(result),
    success: !("error" in result),
  });
  return result;
},
```

---

### Task 4: Wrap `issue_refund` handler with audit logging

**File:** Modify: `src/tools/definitions.ts` (the `issue_refund` handler block)

- [ ] **Step 1: Rewrite the `issue_refund` handler with try/catch + logging**

Replace the existing handler in `definitions.ts`:

```typescript
handler: async (input: {
  order_id: string;
  amount: number;
  reason: string;
  confirmed_by_operator: true;
}) => {
  let result: any;
  try {
    const order = await repo.getOrder(input.order_id);
    if (!order) {
      result = { error: `No order found with ID ${input.order_id}.` };
    } else if (order.status === "refunded") {
      result = { error: `Order ${input.order_id} has already been refunded.` };
    } else {
      const payment = await repo.getPaymentByOrder(input.order_id);
      if (!payment || payment.status !== "captured") {
        result = {
          error: `Order ${input.order_id} has no captured payment to refund (payment status: ${payment?.status ?? "none"}).`,
        };
      } else {
        const r = await repo.issueRefund(input.order_id);
        result = {
          success: true,
          refund_id: r.refundId,
          new_order_status: "refunded",
          reason: input.reason,
        };
      }
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  await repo.logAction({
    order_id: input.order_id,
    tool_name: "issue_refund",
    input_json: JSON.stringify(input),
    result_json: JSON.stringify(result),
    success: !("error" in result),
  });
  return result;
},
```

---

### Task 5: Add audit log test cases

**File:** Modify: `src/tests/tools.test.ts`

- [ ] **Step 1: Add test cases after the existing "lookup on unknown order" check**

Insert before `console.log(\`\n${passed} passed...\`)`:

```typescript
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
```

---

### Task 6: Build, test, verify, commit

- [ ] **Step 1: Run typecheck**

```bash
npx tsc --noEmit --skipLibCheck
```
Expected: no errors

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `14 passed, 0 failed` (plus 3 new checks = 17 total)

- [ ] **Step 3: Rebuild for Supabase deployment**

```bash
npm run build && npm run seed
```
Expected: `Database seeded successfully.`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql src/db/queries.ts src/tools/definitions.ts src/tests/tools.test.ts docs/handoff.md
git commit -m "feat: add audit log for write-tool actions

New action_log table records every reconfirm_order and issue_refund
call (success or rejection) with order_id, tool_name, input_json,
result_json, success, and performed_at. Best-effort logging —
errors in the log insert never block the actual operation."
```

---

## Self-Review

**1. Spec coverage:** Spec has 3 requirements — (a) action_log table ✓ (Task 1), (b) logAction method ✓ (Task 2), (c) logging in both write handlers ✓ (Tasks 3, 4), (d) tests for success + rejection paths ✓ (Task 5), (e) build/test/seed/commit ✓ (Task 6). All covered.

**2. Placeholder scan:** No TBD/TODO/fill-in. All code is concrete.

**3. Type consistency:** Method signatures match — `logAction` takes `{order_id, tool_name, input_json, result_json, success}`, callers pass matching object. Variable names consistent across Tasks 3 and 4.
