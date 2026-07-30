# ops-mcp

A remotely-hosted MCP server that lets a non-technical operations user
resolve a specific, common commerce-ops ticket end-to-end through an AI
agent, instead of escalating to an engineer.

## The workflow this covers

**"Customer says they were charged but the order shows as failed."**

Root cause: payment was captured, but the inventory hold expired before the
order could be confirmed. The agent:

1. Investigates via read-only tools (order, payment, inventory hold, stock).
2. Diagnoses the mismatch and checks current stock.
3. Recommends one of two resolutions:
   - **Stock available** -> reconfirm the order (re-reserve stock, move to
     confirmed).
   - **Stock unavailable** -> issue a refund.
4. Waits for the operator to explicitly approve.
5. Executes the approved action via a write tool.
6. Verifies the outcome (checks shipment status after a reconfirm) before
   reporting success back to the operator.

Out of scope (deliberate): fulfillment/tracking mismatches, returns, fraud
review, catalog/pricing issues, multi-item orders, and full inventory
reconciliation across warehouses. These are structurally similar problems
we'd extend to next using the same investigate -> recommend -> approve ->
execute pattern.

## Data

In-memory SQLite, fully reseeded on every process boot (see
`src/db/schema.ts`). No external database to host or connect to — the
seeded dataset is deterministic so every test run starts from the same
known state. 10 orders are seeded, covering: normal happy-path orders, the
two core scenario orders (A1023 = reconfirm path, A1024 = refund path), and
three deliberate edge cases (an already-refunded order, a cancelled order,
and a "decoy" order that looks similar but isn't actually broken).

## MCP tools

Read (freely callable, no side effects):
- `get_order_details`
- `get_payment_status`
- `get_inventory_hold_status`
- `check_stock_availability`
- `get_shipment_status`

Write (require an explicit `confirmed_by_operator: true` flag, only to be
set once a human has approved the specific action):
- `reconfirm_order`
- `issue_refund`

Full tool descriptions (including preconditions and safety notes fed to
the calling model) are in `src/tools/definitions.ts`.

## Running locally

```
npm install
npm run dev       # starts the MCP server on :3000 with tsx (no build step)
```

Health check: `GET http://localhost:3000/health`
MCP endpoint: `POST http://localhost:3000/mcp`

## Running the tests

```
npm test
```

This runs `src/tests/tools.test.ts`, which calls the tool handlers directly
(bypassing HTTP/MCP transport) against a fresh in-memory DB and checks both
resolution paths plus all safety-rejection cases.

## Building for deployment

```
npm run build
npm start          # runs dist/server.js, respects $PORT
```

## Connecting an MCP client

Point any MCP-over-HTTP client (Streamable HTTP transport, stateless mode)
at `POST /mcp` on the deployed URL.
