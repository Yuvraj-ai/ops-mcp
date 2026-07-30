# ops-mcp Test Instruction Set for OpenCode

## Objective
Test the ops-mcp MCP server end-to-end using OpenCode's MCP client capabilities. Verify all 7 tools work correctly, the safety model holds, and the full investigate → recommend → approve → execute → verify workflow completes successfully.

## Prerequisites
- The ops-mcp server must be running on `http://localhost:3000/mcp` (start with `npm run dev` in the project directory)
- OpenCode must have loaded the `.opencode/mcp.json` config (restart OpenCode or run `/reload` if needed)

## Test Steps

### Phase 1: Tool Discovery & Health Check
1. Verify the MCP server is connected by listing available tools
2. Confirm all 7 tools are registered:
   - `mcp__ops_mcp__get_order_details`
   - `mcp__ops_mcp__get_payment_status`
   - `mcp__ops_mcp__get_inventory_hold_status`
   - `mcp__ops_mcp__check_stock_availability`
   - `mcp__ops_mcp__get_shipment_status`
   - `mcp__ops_mcp__reconfirm_order`
   - `mcp__ops_mcp__issue_refund`
3. Call `mcp__ops_mcp__get_order_details` with `order_id: "A1001"` and verify it returns valid order data

### Phase 2: Scenario A — Reconfirm Path (A1023)
Order A1023: failed status, captured payment, expired hold, stock available (SKU-202 has 12 units)

1. Call `get_order_details` for A1023 — verify status is "failed"
2. Call `get_payment_status` for A1023 — verify payment status is "captured"
3. Call `get_inventory_hold_status` for A1023 — verify hold status is "expired"
4. Call `check_stock_availability` for SKU-202, quantity 1 — verify `sufficient: true`
5. Diagnose: confirm root cause (expired hold on a paid order with available stock)
6. Call `reconfirm_order` for A1023 with `confirmed_by_operator: true` — verify `success: true`
7. Call `get_order_details` for A1023 — verify status is now "confirmed"
8. Call `get_shipment_status` for A1023 — verify shipment exists with status "pending"

### Phase 3: Scenario B — Refund Path (A1024)
Order A1024: failed status, captured payment, expired hold, stock unavailable (SKU-101 has 0 units)

1. Call `get_order_details` for A1024 — verify status is "failed"
2. Call `get_payment_status` for A1024 — verify payment status is "captured"
3. Call `get_inventory_hold_status` for A1024 — verify hold status is "expired"
4. Call `check_stock_availability` for SKU-101, quantity 1 — verify `sufficient: false`
5. Diagnose: confirm root cause (expired hold on a paid order with no stock)
6. Call `issue_refund` for A1024 with `amount: 1799`, `reason: "Stock unavailable after hold expiry"`, `confirmed_by_operator: true` — verify `success: true`
7. Call `get_order_details` for A1024 — verify status is now "refunded"

### Phase 4: Safety Rejection Tests
1. Call `reconfirm_order` for A1025 (already refunded) with `confirmed_by_operator: true` — verify it returns an error
2. Call `issue_refund` for A1026 (cancelled, payment only authorized not captured) with `amount: 1299`, `reason: "test"`, `confirmed_by_operator: true` — verify it returns an error
3. Call `reconfirm_order` for A1027 (decoy — confirmed status, not failed) with `confirmed_by_operator: true` — verify it returns an error
4. Call `get_order_details` for A9999 (nonexistent) — verify it returns a clean error, not a crash

### Phase 5: Edge Case — Happy Path Orders
1. Call `get_order_details` for A1001 (delivered) — verify data
2. Call `get_payment_status` for A1001 — verify payment captured
3. Call `get_shipment_status` for A1001 — verify shipment delivered

## Reporting Format
After completing all phases, produce a report with:

```
## MCP Test Report

### Connection
- MCP server connected: [yes/no]
- Tools discovered: [count]/7

### Phase 2: Reconfirm Path (A1023)
- Order details: [pass/fail] - [details]
- Payment status: [pass/fail] - [details]
- Inventory hold: [pass/fail] - [details]
- Stock check: [pass/fail] - [details]
- Reconfirm call: [pass/fail] - [details]
- Post-reconfirm verification: [pass/fail] - [details]

### Phase 3: Refund Path (A1024)
- Order details: [pass/fail] - [details]
- Payment status: [pass/fail] - [details]
- Inventory hold: [pass/fail] - [details]
- Stock check: [pass/fail] - [details]
- Refund call: [pass/fail] - [details]
- Post-refund verification: [pass/fail] - [details]

### Phase 4: Safety Rejections
- Reconfirm on refunded order (A1025): [pass/fail] - [details]
- Refund on non-captured order (A1026): [pass/fail] - [details]
- Reconfirm on decoy order (A1027): [pass/fail] - [details]
- Lookup on unknown order (A9999): [pass/fail] - [details]

### Phase 5: Happy Path
- A1001 delivered order: [pass/fail] - [details]

### Summary
- Total checks: [N]
- Passed: [N]
- Failed: [N]
- Overall verdict: [PASS/FAIL]

### Issues Found
[List any issues, errors, or unexpected behavior]
```
