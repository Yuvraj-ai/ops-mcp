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
In-memory SQLite (src/db/schema.ts)
        - createDatabase() creates schema + calls seed() on every process boot
        - No external DB — the Node process IS the whole "hosted MCP server"
        - Fully reseeded every boot → deterministic, reproducible test state
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

### Write tools (require `confirmed_by_operator: true`)

| Tool | Input | Preconditions enforced in handler |
|---|---|---|
| `reconfirm_order` | `order_id`, `confirmed_by_operator`, `idempotency_key` (required, agent-generated — see Pending Changes) | Rejects if order is `refunded`/`cancelled`; rejects if status isn't `failed`; replays stored result if `idempotency_key` was already seen |
| `issue_refund` | `order_id`, `amount`, `reason`, `confirmed_by_operator`, `idempotency_key` (required, agent-generated — see Pending Changes) | Rejects if already `refunded`; rejects if no `captured` payment exists; replays stored result if `idempotency_key` was already seen |

Full description strings (the actual text fed to the calling model) live in `src/tools/definitions.ts` — do not summarize/paraphrase these when reasoning about agent behavior; read the exact text, since wording changes are a common source of behavior changes. **Note:** the `idempotency_key` column above reflects the locked target design (see Pending Changes / Decisions Log #8) — it is not yet implemented in the current codebase snapshot described in Section 3.

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

- [ ] **Migrate from in-memory SQLite to hosted PostgreSQL.** Client explicitly wants workflow state and audit history preserved across restarts in the hosted demo — resetting all state on every boot is no longer acceptable. Recommended: Neon (or Supabase) free tier for the Postgres instance, `pg` driver (not an ORM) to keep the migration close to the current `OpsRepository` shape — mostly converting sync `better-sqlite3` calls to async `pg` calls and `?` placeholders to `$1`-style. Seed script should still exist (for reproducible demo data) but should be run once/on-demand, not on every process boot — persistence is now the point.
- [ ] **Add an audit log.** New `action_log` table: `id, order_id, tool_name, input_json, result_json, success, performed_at`. Every call to a write tool (`reconfirm_order`, `issue_refund`) — whether it succeeds or is rejected — should insert a row here. This is what "preserve audit history" means concretely.
- [ ] **Add real idempotency to write tools (Option A — agent-generated key, locked decision).** Add a **required** `idempotency_key` input (string, e.g. a UUID) to `reconfirm_order` and `issue_refund`. The calling agent generates a fresh key per logical attempt at an action; if it retries after a timeout/error, it must reuse the *same* key verbatim. Server stores `(tool_name, idempotency_key) → result` (e.g. in a small `idempotency_keys` table) and replays the stored result on a repeat key instead of re-executing. This is the industry-standard pattern (matches Stripe/PayPal-style idempotency keys) and is layered *in addition to*, not instead of, the existing state-based rejection checks (e.g. "order not failed anymore") — the key catches exact retries, the state check catches "the world changed since." Tool descriptions must explicitly instruct the agent on key-generation/reuse behavior, since this is taught behavior for an LLM caller, not assumed. Bound key storage with an expiry window (Stripe uses 24h) — not required for the demo to fully implement, but note it in the README as a known production concern.
- [ ] **Fix the oversell race condition in `reconfirm_order`.** Current implementation calls `check_stock_availability` as a separate read, then unconditionally decrements stock in `reconfirmOrder()`. Under concurrent requests this has a race window. Fix: make the decrement itself a single atomic conditional update — `UPDATE inventory_stock SET available_qty = available_qty - $1 WHERE sku = $2 AND available_qty >= $1`, check the affected row count, and abort the transaction (return a clear error) if 0 rows were affected. This must happen inside the same transaction as the rest of `reconfirmOrder()`.
- [ ] **Audit that hold/stock mutations are correctly scoped and never touch another order's reservation.** Client flagged "avoid... silently affecting another reservation" — review `reconfirmOrder()` and `issueRefund()` to confirm every mutation is scoped by `order_id`/specific hold `id`, not by SKU alone (a SKU can have many orders' holds against it).
- [ ] **Re-run the full verification suite against the Postgres-backed version** before the next client update. Extend `src/tests/tools.test.ts` (or add a concurrency-specific test) to cover: idempotent retry returns the same result; oversell attempt under low stock is correctly rejected; audit log rows are created for both successful and rejected write attempts.
- [ ] **Update README** to reflect Postgres setup (env var for connection string, how to run the seed script, no more "reseed on every boot" language) and add a short "Idempotency & audit log" section for the evaluator.
- [ ] **Deployment**: host the Node/Express/MCP process (Render/Railway/Fly — developer's choice, confirmed by client), with `DATABASE_URL` pointing at the hosted Postgres instance.

---

## 7. Changelog

*(Claude Code should append an entry here after completing work from the Pending Changes section, with date and summary.)*

- **[Initial version]** — Built and verified locally: schema/seed, data access layer, 7 MCP tools, Express + MCP SDK server with stateless Streamable HTTP transport, 14-test verification suite. Not yet deployed.