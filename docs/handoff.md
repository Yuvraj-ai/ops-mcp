# ops-mcp — Handoff Document

**Purpose of this file:** This is the single source of truth for Claude Code (running locally on the developer's machine) to implement, modify, and extend this project. Claude (this chat) and the developer use this document to track architecture, decisions, and pending work — Claude Code is responsible for all actual codebase changes from this point forward.

**How to use this file with Claude Code:** Paste or reference this file at the start of a Claude Code session with an instruction like: "Read handoff.md and implement the items under 'Pending Changes', then update the 'Changelog' section." After Claude Code completes work, update this file's Changelog and clear/adjust Pending Changes before the next session.

---

## 1. Project Summary

**What this is:** An AI-native commerce-ops tool. A non-technical operations person describes a customer issue in natural language to an AI agent; the agent uses this MCP server's tools to investigate the issue across order/payment/inventory systems, recommend a resolution, get human approval, execute the fix, and verify the outcome — without needing to escalate to an engineer.

**Assignment context:** This is a take-home assignment. Evaluation emphasizes the MCP design (tool quality, safety, descriptions) over feature count or polish. Scope is deliberately small: one coherent end-to-end workflow, not broad coverage.

**The one workflow this covers:**
> "Customer says they were charged but the order shows as failed."

Root cause modeled: payment was captured, but the inventory hold expired before order confirmation completed. Two resolution paths exist depending on current stock:
- **Stock available** → `reconfirm_order` (re-reserve stock, move order to confirmed) → verify via `get_shipment_status`.
- **Stock unavailable** → `issue_refund`.

**Explicitly out of scope (by design, not oversight):**
- Fulfillment/tracking mismatches (shipped-but-no-carrier-scan) — structurally similar, deferred as a "next" item.
- Returns/refund-after-delivery flows.
- Fraud/risk review.
- Catalog/pricing issues.
- Multi-item orders (current model assumes one SKU per order).
- Full cross-warehouse inventory reconciliation.
- Authentication/user management (per assignment instructions, not expected).
- A frontend (per assignment instructions, not expected).

---

## 2. Architecture

```
AI agent (Claude, or any MCP client)
        │  MCP over Streamable HTTP (stateless)
        ▼
Express server (src/server.ts)
        │  registers 7 tools via @modelcontextprotocol/sdk McpServer
        ▼
Tool definitions (src/tools/definitions.ts)
        │  each tool: name, AI-facing description, zod input shape, handler
        ▼
Data access layer (src/db/queries.ts) — OpsRepository class
        │  all SQL lives here, never inline in tool handlers
        ▼
Hosted PostgreSQL (Supabase, via Connection Pooler for IPv4 access)
        - createDatabase() creates schema; seed() called once via `npm run seed`
        - Connection string with pooler host for IPv4 accessibility from any deployment platform
        - State persists across restarts (client requirement)
```

**Key architectural decisions:**
- **In-memory SQLite, reseeded on boot** — avoids needing a separately-hosted database; every test/demo run starts from identical known state. Tradeoff: no persistence across restarts (acceptable for a demo; documented in README).
- **Stateless MCP transport** (`sessionIdGenerator: undefined`, new `McpServer` + transport per request) — simpler to host on basic platforms (Render/Railway/Fly), no sticky-session requirement. Tradeoff: no server-side session state between calls, but this app has none to keep (all state lives in the DB).
- **Read tools vs. write tools, explicitly separated:**
  - Read tools: no side effects, freely re-callable by the agent any number of times, no approval gate.
  - Write tools (`reconfirm_order`, `issue_refund`): require an explicit `confirmed_by_operator: true` field in the tool input. This is a deliberate guardrail — it forces the calling model to pass an affirmative flag rather than just invoking the tool, reducing the chance of acting on ambiguous approval language.
- **Verification-after-write pattern**: tool descriptions instruct the agent to call `get_shipment_status` once after a successful `reconfirm_order`, to confirm the write actually took effect — not just trust a 200-OK-equivalent response.
- **Tool descriptions are written for the AI consumer**, not human API docs — they encode preconditions, when-to-call guidance, and safety constraints inline (see `src/tools/definitions.ts` for exact wording).

---

## 3. Current State (as of last working session)

**Status: working, tested, not yet deployed.**

Files (all under the project root, delivered as `ops-mcp.zip`):
```
src/db/schema.ts         — schema + seed data (10 orders, 5 SKUs)
src/db/queries.ts        — OpsRepository data access class
src/tools/definitions.ts — all 7 MCP tool definitions
src/server.ts            — Express + MCP SDK wiring, stateless HTTP transport
src/tests/tools.test.ts  — 14 runtime checks (all passing)
package.json / tsconfig.json / README.md / .gitignore
```

**Verified working (via curl against the running local server, real MCP protocol calls, not mocked):**
- MCP `initialize` handshake
- All 5 read tools return correct data for seeded orders
- Full diagnostic chain on order A1023 (order → payment → hold → stock check)
- `reconfirm_order` on A1023 succeeds, order status flips to `confirmed`, new hold created, shipment record created
- `get_shipment_status` correctly verifies the reconfirm took effect
- `issue_refund` on A1024 (out-of-stock scenario) succeeds, order flips to `refunded`
- Safety rejections all behave correctly:
  - `reconfirm_order` on already-refunded order (A1025) → rejected with clear error
  - `issue_refund` on order with no captured payment (A1026, cancelled pre-capture) → rejected
  - `reconfirm_order` on a "decoy" order (A1027 — confirmed status, hold still active, not actually broken) → rejected because status isn't `failed`
  - Lookup on unknown order ID → clean error, no crash
- `npm run build` (tsc) compiles with zero errors
- `npm test` → 14/14 passing

**Seed data reference (`src/db/schema.ts`):**

| order_id | customer | order.status | payment.status | hold.status | shipment.status | Purpose |
|---|---|---|---|---|---|---|
| A1001 | Riya Sharma | delivered | captured | released | delivered | happy path |
| A1002 | Karan Mehta | shipped | captured | released | shipped | happy path |
| A1003 | Ayesha Khan | processing | captured | released | processing | happy path |
| A1004 | Vikram Rao | confirmed | captured | active | pending | happy path, early stage |
| A1005 | Neha Joshi | placed | authorized | active | pending | happy path, very early |
| **A1023** | Rohan Gupta | failed | captured | expired | none | **Core scenario, Path B: reconfirm** (SKU-202 has 12 in stock) |
| **A1024** | Sneha Patil | failed | captured | expired | none | **Core scenario, Path A: refund** (SKU-101 has 0 in stock) |
| A1025 | Arjun Nair | refunded | refunded | released | none | edge: already resolved, must refuse re-action |
| A1026 | Meera Iyer | cancelled | authorized (never captured) | released | none | edge: no refund needed/possible |
| A1027 | Farhan Ali | confirmed | captured | active | pending | decoy: looks similar to core scenario but isn't broken |

**Not yet done:**
- Deployment (Render/Railway/Fly — not yet chosen or provisioned)
- Wiring an actual LLM client (e.g. Claude Desktop config) to call this MCP conversationally for the demo video
- Loom video walkthrough
- AI worklog document
- Product-decisions write-up (separate from this handoff doc — that one is for assignment submission, written in plain prose, not this technical format)

---

## 4. MCP Tool Reference

### Read tools (no side effects, no approval needed)

| Tool | Input | Purpose |
|---|---|---|
| `get_order_details` | `order_id` | Order status, customer, amount, SKU, created_at |
| `get_payment_status` | `order_id` | Payment status, amount, captured_at |
| `get_inventory_hold_status` | `order_id` | Hold status (active/expired/released), expiry |
| `check_stock_availability` | `sku`, `quantity` | Current stock, whether sufficient |
| `get_shipment_status` | `order_id` | Shipment status, carrier, last update |

### Write tools (require `confirmed_by_operator: true` and `idempotency_key` UUID)

| Tool | Input | Preconditions enforced in handler |
|---|---|---|
| `reconfirm_order` | `order_id`, `idempotency_key`, `confirmed_by_operator` | Rejects if order is `refunded`/`cancelled`; rejects if status isn't `failed`; atomic conditional stock decrement prevents oversell; replays stored result on repeat `idempotency_key` |
| `issue_refund` | `order_id`, `idempotency_key`, `amount`, `reason`, `confirmed_by_operator` | Rejects if already `refunded`; rejects if no `captured` payment exists; replays stored result on repeat `idempotency_key` |

Full description strings (the actual text fed to the calling model) live in `src/tools/definitions.ts` — do not summarize/paraphrase these when reasoning about agent behavior; read the exact text, since wording changes are a common source of behavior changes.

---

## 5. Decisions Log (why things are the way they are)

1. **Chose one workflow over combining two** — considered merging with a "fulfillment stuck" scenario, rejected it because the two problems have different root causes/entry points and combining would violate the assignment's explicit preference for a small, well-bounded solution over broad coverage.
2. **Extended the single scenario with a verification step** (checking shipment status post-reconfirm) rather than adding a second unrelated scenario — this was judged a "natural continuation" of the same customer journey, not scope creep.
3. **In-memory SQLite over a hosted Postgres** — avoids the "complex deployment infrastructure" the assignment explicitly says not to build.
4. **Explicit `confirmed_by_operator: true` flag on write tools** rather than relying on the model's judgment alone — a deliberate, cheap safety mechanism.
5. **No `search_orders` tool** — deliberately excluded; the workflow always starts from a known order ID (the ops person already has the complaint with an order number in hand). Documented in README as a deliberate exclusion, not an oversight.
6. **Stateless MCP transport (new server+transport per request)** over stateful sessions — simpler hosting story, and this app has no session state worth keeping server-side (all state is in the DB).
7. **[Revision after client feedback] In-memory SQLite → hosted PostgreSQL.** Original reasoning (avoid hosting a separate DB) was overridden by explicit client requirement: they want persisted workflow state and audit history across restarts, not a fresh-every-boot demo. This is a legitimate client-driven scope change, not a mistake in the original design — the original tradeoff was reasonable given the assignment brief alone, but the client has now stated a different priority (durability/auditability over deployment simplicity) and that takes precedence.
8. **[Revision after client feedback, LOCKED] True idempotency via agent-generated key (Option A) over server-derived key or reject-on-retry.** Client used "idempotent" precisely. Considered three options: (a) agent generates a fresh key per attempt, reuses it on retry, server replays stored result on match — the Stripe/PayPal-standard pattern; (b) server derives a key implicitly from `(order_id, tool_name)` — zero burden on the caller, but conflates "duplicate retry" with "any call on this order," which isn't really idempotency, just a redundant state guard; (c) rely on existing state-based rejection alone — safe against double-processing but not idempotent in the strict sense (retries error instead of replaying the original success). **Locked: Option A.** Required (not optional) `idempotency_key` input on both write tools; tool descriptions must explicitly teach the agent to generate-once-per-attempt and reuse-on-retry, since this is taught behavior for an LLM caller. Layered on top of, not instead of, existing state-based checks.
9. **[Revision after client feedback] Oversell protection via atomic conditional UPDATE**, not a separate check-then-write. The original design relied on `check_stock_availability` being called first as a distinct read tool — fine for the single-agent, single-call demo flow, but not safe under concurrent write attempts. The fix keeps `check_stock_availability` as a useful advisory read tool for the agent's reasoning, but adds a hard guarantee at the DB layer so correctness doesn't depend on the calling agent behaving well.

---

## 6. Pending Changes

*(This section should be edited by the developer/Claude before each Claude Code session — list concrete, specific tasks here.)*

**Context:** Client (DiligenceAI Team) reviewed the initial scope email and requested the following architecture changes. Scope/workflow itself is unchanged and fully approved — only the data layer and write-tool robustness need to change.

- [x] **Migrate from in-memory SQLite to hosted PostgreSQL** — DONE: `pg` driver, `pg-mem` for tests, schema.sql DDL, seed.ts standalone script, all async. Tests pass 14/14.
- [x] **Deploy schema + seed to live Supabase** — DONE: connected via ap-southeast-2 pooler endpoint (IPv4), verified all 10 orders + 5 stock items. End-to-end integration test passes against live DB.
- [x] **Add an audit log** — DONE: `action_log` table with `id, order_id, tool_name, input_json, result_json, success, performed_at`. Every write-tool call (success or rejection) inserts a row via `OpsRepository.logAction()`. Best-effort (DB errors caught, never blocks operation). Verified against live Supabase: 2 successes + 1 rejection correctly logged.
- [x] **Add real idempotency via agent-generated key (Option A — locked)** — DONE: New `idempotency_keys` table (`tool_name, key, result, created_at`, PK on `(tool_name, key)`). Both write tools accept a required `idempotency_key: z.string().uuid()` input. Handlers check the idempotency table first — if key exists, replay stored result without re-executing. After fresh execution, store the result. Audit logging happens for every call (including replays). Best-effort (DB errors caught, never blocks operation). Verified against live Supabase: retry with same key returns stored success, oversell rejection is correctly replayed.
- [x] **Fix the oversell race condition in `reconfirm_order`** — DONE: stock decrement is now atomic conditional `UPDATE ... WHERE sku = $2 AND available_qty >= $1`; if 0 rows affected, throws and rolls back. Verified against live Supabase: A1024 (SKU-101 at 0 stock) correctly rejected, stock not decremented. 3 new test cases pass (24/24 total).
- [x] **Audit that hold/stock mutations are correctly scoped** — Verified: `reconfirmOrder()` scopes stock decrement by `sku` (within a transaction tied to specific `hold.id` and `order_id`); `issueRefund()` scopes by `order_id`. No SKU-only mutations that could affect another order's reservation.
- [x] **Update README for Postgres setup** — DONE: pooler guidance, platform notes (Heroku/Render/Vercel)
- [~] **Deployment (Render/Railway/Fly)** — Infrastructure ready (`.env` with pooler connection string, Supabase schema seeded); hosting platform deployment pending user approval

> **Note:** The PostgreSQL migration is complete and verified. Remaining tasks are pending user approval before starting — per the implementation policy documented in `memory.md`, no new task begins without explicit go-ahead.

---

## 7. Changelog

*(Claude Code should append an entry here after completing work from the Pending Changes section, with date and summary.)*

- **[Initial version]** — Built and verified locally: schema/seed, data access layer, 7 MCP tools, Express + MCP SDK server with stateless Streamable HTTP transport, 14-test verification suite. Not yet deployed.
- [2026-07-31] — Migrated from in-memory SQLite to hosted PostgreSQL. Replaced `better-sqlite3` with `pg` driver. Extracted DDL to `src/db/schema.sql`. Moved seed data to standalone `src/db/seed.ts` (run via `npm run seed`). All `OpsRepository` methods and tool handlers are now async with `$1`-style parameterized queries and proper `BEGIN`/`COMMIT`/`ROLLBACK` transactions. Tests updated to use `pg-mem` (in-memory PostgreSQL) — all 14 tests pass. Added `.env.example` and `build`/`postbuild`/`seed` scripts to `package.json`. README updated with Postgres setup instructions.
- [2026-07-31] — Deployed schema + seed data to live Supabase Postgres (ap-southeast-2 pooler endpoint). Resolved IPv6 connectivity limitation by using Supabase's Connection Pooler (IPv4-accessible). Updated `.env` with pooler connection string. Added `ssl` config to `createPool()` and seed CLI for Supabase connections. Added `dotenv` dependency for `.env` loading in `server.ts` and `seed.ts`. Verified end-to-end against live DB: full diagnostic chain (order → payment → hold → stock) and `reconfirm_order` → `get_shipment_status` verification all pass. Updated README with Supabase pooler guidance and Heroku/Render/Vercel platform notes.
- [2026-08-01] — Added audit log. New `action_log` table in `schema.sql` (`id, order_id, tool_name, input_json, result_json, success, performed_at` + index on `(order_id, performed_at)`). Added `logAction()` to `OpsRepository` (best-effort — catches errors, never blocks operation). Wrapped both write-tool handlers (`reconfirm_order`, `issue_refund`) in try/catch with audit logging after result computation, capturing both successes and handler-level rejections. Added 3 test cases — 17/17 tests pass. Verified against live Supabase: audit log correctly records 2 successes and 1 rejection.
- [2026-08-01] — Added idempotency keys + fixed oversell race condition. New `idempotency_keys` table (`tool_name, key, result, created_at`, composite PK). Both write tools now require a `idempotency_key` UUID input — if the key was already seen, the server replays the stored result without re-executing. Audit logging happens for every call including replays. Stock decrement in `reconfirm_order` is now an atomic conditional `UPDATE ... WHERE sku = $2 AND available_qty >= $1` — 0 rows affected → throws → ROLLBACK → returns clear error. Verified against live Supabase: idempotency replay works, oversell prevention works, audit log records both calls. 24/24 tests pass.
- [2026-08-01] — Fixed oversell race condition in `reconfirm_order`. Stock decrement is now an atomic conditional `UPDATE inventory_stock SET available_qty = available_qty - $1 WHERE sku = $2 AND available_qty >= $1`; if 0 rows affected (insufficient stock), throws and aborts the transaction with ROLLBACK. Verified against live Supabase: A1024 (SKU-101 at 0 stock) correctly rejected with "Insufficient stock" error, stock not decremented. Added 3 oversell-prevention test cases (20/20 total). Also audited all mutations in `reconfirmOrder()` and `issueRefund()` — all scoped by `order_id` or specific hold `id`, no SKU-only mutations that could affect another order's reservation.