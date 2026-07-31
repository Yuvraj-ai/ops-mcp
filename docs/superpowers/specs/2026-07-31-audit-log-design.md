# Audit Log Design Spec

## Goal
Record every write-tool action (`reconfirm_order`, `issue_refund`) — successful or rejected — into an `action_log` table for compliance and debugging.

## Approach
**Handler-level logging** (Approach A): Each write-tool handler in `src/tools/definitions.ts` wraps its body in try/catch, calls a new `OpsRepository.logAction()` method after computing the result, then returns the original result. The logging is best-effort (errors are caught and logged to stderr, never blocking the actual operation).

## Schema Change
New table in `src/db/schema.sql`:

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
```

Plus an index for order-level lookups:
```sql
CREATE INDEX IF NOT EXISTS action_log_order_id_idx ON action_log(order_id, performed_at DESC);
```

## Repository Change
Add `logAction()` to `OpsRepository` in `src/db/queries.ts`:

```typescript
async logAction(params: {
  order_id: string | null;
  tool_name: string;
  input_json: string;
  result_json: string;
  success: boolean;
}): Promise<void>
```

Best-effort insert — catches and logs errors, never throws.

## Handler Change
Each write-tool handler (`reconfirm_order`, `issue_refund`) in `src/tools/definitions.ts`:

1. Wrap existing handler body in `try { ... } catch (err) { result = { error: err.message } }`
2. After the try/catch, call `await repo.logAction(...)` with the result
3. Return the original result unchanged

Example for `reconfirm_order`:
```typescript
handler: async (input: { order_id: string; confirmed_by_operator: true }) => {
  let result: any;
  try {
    const order = await repo.getOrder(input.order_id);
    if (!order) { result = { error: `No order found with ID ${input.order_id}.` }; }
    else if (order.status === "refunded" || order.status === "cancelled") { result = { error: ... }; }
    else if (order.status !== "failed") { result = { error: ... }; }
    else {
      const r = await repo.reconfirmOrder(input.order_id);
      result = { success: true, ... };
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

`issue_refund` follows the same pattern.

## Testing
1. Add a test case that calls `reconfirm_order` on A1023 and then queries `action_log` to verify a row was inserted with `success=true`.
2. Add a test case that calls `reconfirm_order` on A1025 (already refunded → rejected) and verifies a row was inserted with `success=false`.

## Out of Scope
- Read tools are not logged (spec says "write tools" only).
- No retention policy for old log rows (noted as production concern in README).
