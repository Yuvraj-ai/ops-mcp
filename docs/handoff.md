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
- **Hosted PostgreSQL (Supabase), not in-memory SQLite** — client-requested revision (see Decisions Log #7); state and audit history now persist across restarts. Seed script runs once via `npm run seed`, not on every boot.
- **Stateless MCP transport** (`sessionIdGenerator: undefined`, new `McpServer` + transport per request) — simpler to host on basic platforms (Render/Railway/Fly), no sticky-session requirement. Tradeoff: no server-side session state between calls, but this app has none to keep (all state lives in the DB).
- **Read tools vs. write tools, explicitly separated:**
  - Read tools: no side effects, freely re-callable by the agent any number of times, no approval gate.
  - Write tools (`reconfirm_order`, `issue_refund`): require an explicit `confirmed_by_operator: true` field in the tool input. This is a deliberate guardrail — it forces the calling model to pass an affirmative flag rather than just invoking the tool, reducing the chance of acting on ambiguous approval language.
- **Verification-after-write pattern**: tool descriptions instruct the agent to call `get_shipment_status` once after a successful `reconfirm_order`, to confirm the write actually took effect — not just trust a 200-OK-equivalent response.
- **Tool descriptions are written for the AI consumer**, not human API docs — they encode preconditions, when-to-call guidance, and safety constraints inline (see `src/tools/definitions.ts` for exact wording).

---

## 3. Current State (as of last working session)

**Status: fully deployed and verified. Live at `https://ops-mcp.onrender.com` (Render free tier), backed by a live Supabase Postgres instance. Only remaining step before final submission is a one-time production seed reset (see Pending Changes) — no open engineering work.**

Files (all under the project root, delivered as `ops-mcp.zip`):
```
src/db/schema.sql        — DDL: orders, payments, inventory_holds, inventory_stock,
                            shipments, action_log, idempotency_keys
src/db/seed.ts            — standalone seed script (run once via `npm run seed`, not on boot)
src/db/queries.ts        — OpsRepository data access class (async, transactions, audit, idempotency)
src/tools/definitions.ts — all 7 MCP tool definitions
src/server.ts            — Express + MCP SDK wiring, stateless HTTP transport
src/tests/tools.test.ts  — 30 runtime checks (all passing, run against pg-mem)
package.json / tsconfig.json / README.md / .gitignore / .env.example
```

**Verified working — both locally (pg-mem) and against the live Supabase instance:**
- MCP `initialize` handshake
- All 5 read tools return correct data for seeded orders
- Full diagnostic chain on order A1023 (order → payment → hold → stock check)
- `reconfirm_order` on A1023 succeeds, order status flips to `confirmed`, new hold created, shipment record created — audit log row and idempotency-key row committed atomically with the mutation
- `get_shipment_status` correctly verifies the reconfirm took effect
- `issue_refund` on A1024 (out-of-stock scenario) succeeds, order flips to `refunded`
- Retrying a write call with the same `idempotency_key` replays the original stored result rather than re-executing
- Oversell attempt correctly rejected via atomic conditional stock update (0 rows affected → rollback), verified specifically against A1024 (SKU-101 at 0 stock)
- Safety rejections all behave correctly:
  - `reconfirm_order` on already-refunded order (A1025) → rejected with clear error
  - `issue_refund` on order with no captured payment (A1026, cancelled pre-capture) → rejected
  - `reconfirm_order` on a "decoy" order (A1027 — confirmed status, hold still active, not actually broken) → rejected because status isn't `failed`
  - Lookup on unknown order ID → clean error, no crash
- `npm run build` (tsc) compiles with zero errors
- `npm test` → **30/30 passing** (pg-mem); **11/11 live checks passing** against Supabase

**Seed data reference (`src/db/seed.ts`):**

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
- One-time production seed reset (`npm run seed -- --reset`) immediately before final demo recording/submission — deliberately not done yet, see Pending Changes
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
3. **[SUPERSEDED by #7 below] In-memory SQLite over a hosted Postgres** — avoided the "complex deployment infrastructure" the assignment explicitly says not to build. This was the right call given the assignment brief alone; superseded once the client stated a different priority (see #7).
4. **Explicit `confirmed_by_operator: true` flag on write tools** rather than relying on the model's judgment alone — a deliberate, cheap safety mechanism.
5. **No `search_orders` tool** — deliberately excluded; the workflow always starts from a known order ID (the ops person already has the complaint with an order number in hand). Documented in README as a deliberate exclusion, not an oversight.
6. **Stateless MCP transport (new server+transport per request)** over stateful sessions — simpler hosting story, and this app has no session state worth keeping server-side (all state is in the DB).
7. **[Revision after client feedback] In-memory SQLite → hosted PostgreSQL.** Original reasoning (avoid hosting a separate DB) was overridden by explicit client requirement: they want persisted workflow state and audit history across restarts, not a fresh-every-boot demo. This is a legitimate client-driven scope change, not a mistake in the original design — the original tradeoff was reasonable given the assignment brief alone, but the client has now stated a different priority (durability/auditability over deployment simplicity) and that takes precedence.
8. **[Revision after client feedback, LOCKED] True idempotency via agent-generated key (Option A) over server-derived key or reject-on-retry.** Client used "idempotent" precisely. Considered three options: (a) agent generates a fresh key per attempt, reuses it on retry, server replays stored result on match — the Stripe/PayPal-standard pattern; (b) server derives a key implicitly from `(order_id, tool_name)` — zero burden on the caller, but conflates "duplicate retry" with "any call on this order," which isn't really idempotency, just a redundant state guard; (c) rely on existing state-based rejection alone — safe against double-processing but not idempotent in the strict sense (retries error instead of replaying the original success). **Locked: Option A.** Required (not optional) `idempotency_key` input on both write tools; tool descriptions must explicitly teach the agent to generate-once-per-attempt and reuse-on-retry, since this is taught behavior for an LLM caller. Layered on top of, not instead of, existing state-based checks.
9. **[Revision after client feedback] Oversell protection via atomic conditional UPDATE**, not a separate check-then-write. The original design relied on `check_stock_availability` being called first as a distinct read tool — fine for the single-agent, single-call demo flow, but not safe under concurrent write attempts. The fix keeps `check_stock_availability` as a useful advisory read tool for the agent's reasoning, but adds a hard guarantee at the DB layer so correctness doesn't depend on the calling agent behaving well.
10. **`--reset` should scope to business state only, not the audit log.** Caught during pre-submission review: the seed script's `--reset` flag originally truncated `action_log` along with everything else. Decided this is wrong in principle, not just inconvenient — an audit log that gets wiped every time demo data is reset can't function as an audit log; it becomes just another piece of disposable state. The client's own phrasing ("preserve workflow state **and** audit history") treats these as two distinct things, and the fix treats them that way too: `--reset` clears orders/payments/holds/stock/shipments back to a known demo state, but `action_log` persists through a reset. `idempotency_keys` stays in the reset scope, since those rows are only meaningful in the context of the specific business-state mutation they were generated against — resetting the state underneath them makes them orphaned regardless of whether they're kept.

---

## 6. Pending Changes

*(This section should be edited by the developer/Claude before each Claude Code session — list concrete, specific tasks here.)*

**Context:** All client-requested architecture changes (Postgres, audit history, idempotency, oversell protection — Decisions Log #7–9) and public deployment are complete and verified. One real fix identified below; the rest is submission-prep, not code.

- [x] **Exclude `action_log` from the `--reset` TRUNCATE list.** Current `seed.ts` `--reset` flag ran `TRUNCATE idempotency_keys, action_log, shipments, inventory_holds, inventory_stock, payments, orders RESTART IDENTITY CASCADE` — this wiped the audit trail along with business state on every reset. The client's requirement was to "preserve workflow state **and** audit history" as two distinct things. Audit log's entire purpose is to be a durable historical record and should survive resets, or it can never function as an audit trail. Fix: removed `action_log` from the TRUNCATE statement, so `--reset` becomes "reset business state, preserve the permanent record." `idempotency_keys` remains in the reset list — those rows only have meaning tied to the specific business-state mutation they were generated against, so they become meaningless orphans once that state is reset, unlike audit history. README's `--reset` documentation updated to reflect this distinction explicitly.
- [ ] **Reset production DB to clean seed state before final submission.** Run `npm run seed -- --reset` (locally, pointed at the production `DATABASE_URL`) once, right before recording the demo / submitting — not before, and only after the `action_log` exclusion fix above lands. Current production DB has real mutation history (A1023 already reconfirmed during testing) which is fine to leave in place until the very last step.

Everything else — Postgres migration, live Supabase deployment, audit log, idempotency keys, oversell-race fix, transactional coupling, reservation scoping audit, README update, public hosting on Render, seed script safety — is DONE and verified. Full detail in the Changelog below.

---

## 7. Changelog

*(Claude Code should append an entry here after completing work from the Pending Changes section, with date and summary.)*

- **[Initial version]** — Built and verified locally: schema/seed, data access layer, 7 MCP tools, Express + MCP SDK server with stateless Streamable HTTP transport, 14-test verification suite. Not yet deployed.
- **[2026-07-31] Postgres migration.** Replaced `better-sqlite3` with `pg` driver; DDL extracted to `src/db/schema.sql`; seed data moved to standalone `src/db/seed.ts` (run via `npm run seed`, not on boot). All `OpsRepository` methods and tool handlers made async with `$1`-style parameterized queries and `BEGIN`/`COMMIT`/`ROLLBACK` transactions. Tests migrated to `pg-mem` (in-memory Postgres-compatible mock) — 14/14 passing. Added `.env.example`, `build`/`postbuild`/`seed` npm scripts. README updated.
- **[2026-07-31] Live Supabase deployment.** Schema + seed deployed to a live Supabase Postgres instance (ap-southeast-2 pooler endpoint, resolving an IPv6-connectivity limitation via Supabase's Connection Pooler). Added `dotenv` + SSL config. Verified end-to-end against the live DB: full diagnostic chain and `reconfirm_order` → `get_shipment_status` verification. README updated with pooler + platform (Heroku/Render/Vercel) guidance.
- **[2026-08-01] Audit log, idempotency keys, oversell fix, transactional coupling.** Added `action_log` table (every write-tool call — success or rejection — logged) and `idempotency_keys` table (composite PK `tool_name, key`; both write tools require a UUID `idempotency_key`, repeat keys replay the stored result instead of re-executing). Fixed the oversell race condition: stock decrement in `reconfirm_order` is now a single atomic conditional `UPDATE ... WHERE sku = $2 AND available_qty >= $1` — 0 rows affected aborts the transaction with a clear error. **Follow-up correction:** the audit and idempotency writes were initially implemented as best-effort/decoupled from the mutation, which did not meet the client's explicit requirement that the audit record for an approved mutation share the same transaction as the mutation. Corrected: for the success path, the `action_log` and `idempotency_keys` inserts now execute inside the same transaction as the mutation itself (atomic commit/rollback together). Rejection-path audit rows (nothing to couple to) remain standalone inserts, which is the correct behavior since there's no mutation for them to share atomicity with. Audited all mutations in `reconfirmOrder()`/`issueRefund()` — confirmed scoped by `order_id`/specific hold `id`, never by SKU alone. Final result: **30/30 tests passing** (pg-mem), **11/11 live checks passing** against Supabase (transactional atomicity, idempotent replay, oversell prevention, reconfirm happy path).
- **[2026-07-31] Public deployment on Render.** Deployed to Render free-tier Web Service at `https://ops-mcp.onrender.com`, build command `npm install && npm run build`, start command `npm start`, `DATABASE_URL` set to the Supabase pooler connection string. Postbuild step copies `src/db/schema.sql` into `dist/db/`. Verified live: `/health` returns all 7 tools, MCP `initialize` handshake succeeds over HTTPS, `tools/call` against `get_order_details` returns correct data for A1023 — confirming state genuinely persisted across the entire chain (local testing → Postgres migration → transactional fix → fresh Render deploy). Known tradeoff: free-tier instance sleeps after ~15 min idle, causing a cold-start delay (~30-50s) on the first request after a gap — to be mitigated with a keep-warm ping (e.g. cron-job.org hitting `/health` periodically) before evaluation/recording, or simply noted in the README.
- **[2026-08-01] Seed script reset safety.** `seed.ts` previously used `ON CONFLICT DO NOTHING` — safe to re-run without crashing, but would not reset rows that had been mutated by real usage (e.g. a reconfirmed order stayed `confirmed` on re-seed, not reset to `failed`). Fixed: default behavior unchanged (still safe for accidental re-runs against a live DB); added an explicit `--reset` flag (`npm run seed -- --reset`) that runs `TRUNCATE ... RESTART IDENTITY CASCADE` across all app tables before re-seeding, for a genuine clean-slate reset. README updated to document both behaviors. Intended use: run `npm run seed -- --reset` against production `DATABASE_URL` once, immediately before final demo recording/submission — not before, since the current production DB's mutation history (e.g. A1023 already reconfirmed) is legitimate evidence the system has been exercised for real.
- **[2026-08-01] Seed reset preserves audit history.** Fixed `--reset` flag in `seed.ts` to exclude `action_log` from the TRUNCATE list. The audit trail is a durable historical record by design (client requirement: "preserve workflow state and audit history as two distinct things"). `--reset` now truncates only business-state tables (`orders`, `payments`, `inventory_holds`, `inventory_stock`, `shipments`) plus `idempotency_keys` (orphaned once their mutations are gone), while `action_log` rows persist. Correspondingly removed `action_log` from the test teardown's `DROP TABLE` list — `initDatabase()` recreates it via `CREATE TABLE IF NOT EXISTS` in `schema.sql` regardless. README's `--reset` documentation updated to explain this distinction explicitly.