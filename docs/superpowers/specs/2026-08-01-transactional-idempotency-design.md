# Transactional Audit + Idempotency Design Spec

## Problem
Current implementation: `reconfirmOrder()`/`issueRefund()` commit their transactions, then the handler does standalone `logAction()` and `storeIdempotencyResult()` calls. If those fail, the mutation is committed but the audit/idempotency records are lost — violating the client requirement: "keep the audit record for an approved mutation in the same transaction as the mutation."

## Fix
Move audit log + idempotency key storage **inside** the repository methods' transactions:

**Success path:** `BEGIN → mutations → audit_log INSERT → idempotency_keys INSERT → COMMIT`
**Error path:** `BEGIN → ... → ROLLBACK → audit + idempotency done as standalone inserts by handler`

## Changes

### `reconfirmOrder(orderId, idempotencyKey, inputJson)`
1. Accept new params: `idempotencyKey`, `inputJson`
2. After mutations, before COMMIT: insert audit_log + idempotency_keys using same `client`
3. Return full result object: `{ success: true, new_order_status, new_hold_id, note }`
4. On any error: ROLLBACK + throw (handler catches and does standalone audit + idempotency)

### `issueRefund(orderId, idempotencyKey, inputJson, reason)`
1. Accept new params: `idempotencyKey`, `inputJson`, `reason`
2. After mutations, before COMMIT: insert audit_log + idempotency_keys using same `client`
3. Return full result object: `{ success: true, refund_id, new_order_status, reason }`
4. On any error: ROLLBACK + throw

### Handlers (`definitions.ts`)
1. **Replay path:** standalone `logAction()` (no mutation, no idempotency store)
2. **Validation rejection:** standalone `logAction()` + `storeIdempotencyResult()`
3. **Execution error (repo threw):** standalone `logAction()` + `storeIdempotencyResult()`
4. **Success:** repo method handles everything in its transaction — handler just returns result

### `logAction()` — no changes needed
Still used standalone for rejection paths. Success path audit log is done directly in repo method's transaction via `client.query`.

### `storeIdempotencyResult()` — no changes needed
Still used standalone for rejection paths. Success path idempotency key is stored directly in repo method's transaction via `client.query`.

## Testing
- Existing 24 tests still pass (no behavior change for tests)
- Add 1 test: verify idempotency + audit log are committed together (check both tables after successful reconfirm)
- Verify against live Supabase: mutation + audit + idempotency key all present after successful operation
