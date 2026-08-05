# ops-mcp — Project Handoff

**What this document is:** the closing record for ops-mcp — what was built, why it
was built that way, what went wrong along the way, and how each claim about it was
verified. It is a finished project history, not a task tracker.

**Status: complete and deployed.** Live at `https://ops-mcp.onrender.com`, backed
by a hosted Supabase Postgres instance. All client-requested revisions from both
review rounds are implemented, tested, and committed, along with one defect found
and fixed beyond that scope. One known gap is documented and disclosed in
Appendix A.6 rather than left to be discovered.

---

## 1. Project Summary

**What this is:** An AI-native commerce-ops tool. A non-technical operations person
describes a customer issue in natural language to an AI agent; the agent uses this
MCP server's tools to investigate the issue across order/payment/inventory systems,
recommend a resolution, get human approval, execute the fix, and verify the outcome
— without needing to escalate to an engineer.

**Assignment context:** This is a take-home assignment. Evaluation emphasizes the
MCP design (tool quality, safety, descriptions) over feature count or polish. Scope
is deliberately small: one coherent end-to-end workflow, not broad coverage.

**The one workflow this covers:**
> "Customer says they were charged but the order shows as failed."

Root cause modeled: payment was captured, but the inventory hold expired before
order confirmation completed. Two resolution paths exist depending on current stock:
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
        - initDatabase() creates schema; seed() run once via `npm run seed`
        - Pooler host for IPv4 accessibility from any deployment platform
        - State persists across restarts (client requirement)
```

**Key architectural decisions:**
- **Hosted PostgreSQL (Supabase), not in-memory SQLite** — client-requested revision (Decisions Log #7); state and audit history persist across restarts. Seed script runs once via `npm run seed`, not on every boot.
- **Stateless MCP transport** (`sessionIdGenerator: undefined`, new `McpServer` + transport per request) — simpler to host on basic platforms (Render/Railway/Fly), no sticky-session requirement. Tradeoff: no server-side session state between calls, but this app has none to keep (all state lives in the DB).
- **Read tools vs. write tools, explicitly separated:**
  - Read tools: no side effects, freely re-callable by the agent any number of times, no approval gate.
  - Write tools (`reconfirm_order`, `issue_refund`): require an explicit `confirmed_by_operator: true` field in the tool input. This is a deliberate guardrail — it forces the calling model to pass an affirmative flag rather than just invoking the tool, reducing the chance of acting on ambiguous approval language.
- **Correctness enforced at the database layer, not in the agent's reasoning.** Every write-tool precondition that matters is a conditional `UPDATE` whose `WHERE` clause re-checks the state at write time, with the affected row count aborting the transaction if the state moved. The agent's read-tool checks remain useful for explaining its reasoning to the operator, but correctness does not depend on the agent behaving well.
- **Verification-after-write pattern**: tool descriptions instruct the agent to call `get_shipment_status` once after a successful `reconfirm_order`, to confirm the write actually took effect — not just trust a 200-OK-equivalent response.
- **Tool descriptions are written for the AI consumer**, not human API docs — they encode preconditions, when-to-call guidance, and safety constraints inline (see `src/tools/definitions.ts` for exact wording).

---

## 3. Final State

**Deployed:** `https://ops-mcp.onrender.com` (Render free-tier Web Service),
`DATABASE_URL` pointing at the Supabase pooler. Free-tier instances sleep after
~15 min idle, so the first request after a gap takes ~30–50 s; mitigate with a
keep-warm ping to `/health` before a demo.

**Files:**
```
src/db/schema.sql            — DDL: orders, payments, inventory_holds,
                                inventory_stock, shipments, action_log,
                                idempotency_keys
src/db/seed.ts               — standalone seed script (`npm run seed`, not on boot)
src/db/schema.ts             — pool creation + initDatabase()
src/db/queries.ts            — OpsRepository: all SQL, transactions, audit,
                                idempotency, conditional-write guards
src/tools/definitions.ts     — all 7 MCP tool definitions
src/server.ts                — Express + MCP SDK wiring, stateless HTTP transport
src/tests/testdb.ts          — test harness: real Postgres, isolated schema
src/tests/tools.test.ts      — 54 runtime checks
src/tests/concurrency.test.ts — 18 concurrent-access checks
package.json / tsconfig.json / README.md / .gitignore / .env.example
```

**Test results:**

| Suite | Command | Result |
|---|---|---|
| Tool + safety + audit + idempotency + guards + inventory release | `npm test` | **54/54** |
| Concurrent access | `npm run test:concurrency` | **18/18** |
| Compile | `npm run build` | clean, zero errors |
| Live Supabase end-to-end | manual | 11/11 |

Tests run against **real PostgreSQL**, in a dedicated `ops_mcp_test` schema that
the harness drops and recreates per run. Demo data in the `public` schema is
structurally out of reach of a test run — including one that fails partway and
leaves rows half-mutated. `pg-mem` was removed entirely; the reasoning is in
Appendix A.3, and it is the single most consequential testing decision in the
project.

**Verified behavior:**
- MCP `initialize` handshake over HTTPS; `/health` reports all 7 tools
- All 5 read tools return correct data for seeded orders
- Full diagnostic chain on A1023 (order → payment → hold → stock)
- `reconfirm_order` on A1023 flips status to `confirmed`, creates a new hold and shipment record, with the audit row and idempotency row committed **in the same transaction** as the mutation
- `get_shipment_status` confirms the reconfirm took effect
- `issue_refund` on A1024 (out of stock) flips the order to `refunded`
- Sequential retry with the same `idempotency_key` replays the stored result instead of re-executing
- Oversell rejected by atomic conditional stock decrement (0 rows → rollback), verified against A1024 (SKU-101 at 0)
- **Transactional rollback genuinely verified** — an aborted guard leaves no partial write (this was unverifiable before the test-database migration; see Appendix A.3)
- **Concurrency verified under real contention** — two simultaneous `reconfirm_order` calls with different idempotency keys produce exactly one success, one active hold, one stock decrement, one success row in `action_log`, and an actionable error for the loser
- Safety rejections behave correctly: already-refunded order (A1025), no captured payment (A1026), decoy non-failed order (A1027), unknown order ID → clean error, no crash
- `issue_refund` releases any live inventory hold and credits the units back to available stock, in the same transaction as the refund — no phantom reservations
- Rejection-path audit/idempotency failures are non-blocking **and** traceable — tagged log lines naming the tool, order or key, and the operational consequence

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

**Outside the code scope** (not engineering work): the Loom walkthrough and the
recorded conversational demo against a live LLM client. The AI worklog
(`ai-worklog.md`) and the product-decisions write-up (`product-decisions.md`) were
produced as standalone submission files rather than repo artifacts, so they do not
appear in commit history. A per-session engineering log lives in
`docs/claude-code-worklog-extract.md`.

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

| Tool | Input | Preconditions enforced |
|---|---|---|
| `reconfirm_order` | `order_id`, `idempotency_key`, `confirmed_by_operator` | Rejects if order is `refunded`/`cancelled` or status isn't `failed`; atomic conditional stock decrement prevents oversell; **conditional status UPDATE prevents concurrent double-confirmation**; replays stored result on repeat `idempotency_key` |
| `issue_refund` | `order_id`, `idempotency_key`, `amount`, `reason`, `confirmed_by_operator` | Rejects if already `refunded` or if no `captured` payment exists; **conditional status UPDATE prevents concurrent double-refund**; **releases any active inventory hold and credits stock back in the same transaction**; replays stored result on repeat `idempotency_key` |

Full description strings (the actual text fed to the calling model) live in
`src/tools/definitions.ts` — do not summarize or paraphrase these when reasoning
about agent behavior; read the exact text, since wording changes are a common
source of behavior changes.

### Write-path safety model

Four independent layers, each covering what the one above it cannot:

1. **Operator approval** — `confirmed_by_operator: true` must be set explicitly.
2. **State preconditions** — the handler rejects orders in states where the action makes no sense, with an explanatory message the agent can relay.
3. **Idempotency** — an agent-generated UUID; a repeat key replays the stored result rather than re-executing.
4. **Conditional writes** — every consequential `UPDATE` re-checks its precondition in the `WHERE` clause at write time; 0 affected rows aborts the transaction. This is what holds when two requests race, since layers 2 and 3 both read state that can move before the write lands.

The audit row and idempotency row for a successful mutation commit **inside the
same transaction** as the mutation itself — they cannot disagree with what
actually happened. Rejection-path audit rows are standalone inserts, which is
correct: there is no mutation for them to share atomicity with.

---

## 5. Decisions Log (why things are the way they are)

1. **Chose one workflow over combining two** — considered merging with a "fulfillment stuck" scenario, rejected because the two problems have different root causes/entry points and combining would violate the assignment's explicit preference for a small, well-bounded solution over broad coverage.
2. **Extended the single scenario with a verification step** (checking shipment status post-reconfirm) rather than adding a second unrelated scenario — judged a natural continuation of the same customer journey, not scope creep.
3. **[SUPERSEDED by #7] In-memory SQLite over hosted Postgres** — avoided the "complex deployment infrastructure" the assignment explicitly says not to build. The right call given the brief alone; superseded once the client stated a different priority.
4. **Explicit `confirmed_by_operator: true` flag on write tools** rather than relying on the model's judgment alone — a deliberate, cheap safety mechanism.
5. **No `search_orders` tool** — deliberately excluded; the workflow always starts from a known order ID (the ops person has the complaint with an order number in hand). Documented in the README as a deliberate exclusion, not an oversight.
6. **Stateless MCP transport (new server + transport per request)** over stateful sessions — simpler hosting story, and this app has no session state worth keeping server-side.
7. **[Client revision] In-memory SQLite → hosted PostgreSQL.** Original reasoning (avoid hosting a separate DB) was overridden by an explicit client requirement for persisted workflow state and audit history across restarts. A legitimate client-driven scope change, not a mistake in the original design: the original tradeoff was reasonable given the brief alone, but the client stated a different priority (durability/auditability over deployment simplicity) and that takes precedence.
8. **[Client revision, LOCKED] True idempotency via agent-generated key.** The client used "idempotent" precisely. Three options were considered: (a) agent generates a fresh key per attempt, reuses it on retry, server replays the stored result on match — the Stripe/PayPal-standard pattern; (b) server derives a key implicitly from `(order_id, tool_name)` — zero caller burden, but conflates "duplicate retry" with "any call on this order," which is a redundant state guard rather than idempotency; (c) rely on state-based rejection alone — safe against double-processing but not idempotent in the strict sense, since retries error instead of replaying. **Locked: option (a).** Required (not optional) `idempotency_key` on both write tools; the tool descriptions explicitly teach generate-once-per-attempt and reuse-on-retry, since that is taught behavior for an LLM caller. Layered on top of, not instead of, the state-based checks.
9. **[Client revision] Oversell protection via atomic conditional UPDATE**, not check-then-write. The original design relied on `check_stock_availability` being called first — fine for a single-agent demo flow, unsafe under concurrent writes. The read tool remains useful for the agent's reasoning, but the hard guarantee now lives at the DB layer.
10. **`--reset` scopes to business state only, never the audit log.** The seed script's `--reset` originally truncated `action_log` along with everything else. This is wrong in principle, not merely inconvenient: an audit log wiped on every demo reset cannot function as an audit log. The client's own phrasing ("preserve workflow state **and** audit history") treats these as two distinct things, and the fix does too. `idempotency_keys` stays in the reset scope, since those rows are only meaningful against the specific mutation they were generated for and are orphaned once that state is reset.
11. **[Second review] Transaction isolation is a property of the connection, not the code block.** A read issued via the pool from inside a `BEGIN` block does not participate in that transaction, however it reads on the page. Every read inside a transaction now runs on the transaction's own client. This also removes a self-deadlock risk: a transaction holding one connection requesting a second from a saturated pool.
12. **[Second review] Guard every consequential UPDATE, not just the obvious one.** The stock decrement was already conditional; the order status flip was not. Two concurrent calls with different idempotency keys could both read `failed` and both proceed. The general principle adopted: any `UPDATE` whose correctness depends on state read earlier must re-check that state in its own `WHERE` clause and treat 0 affected rows as an abort.
13. **[Second review] Test against the real engine, not an imitation of it.** `pg-mem` was found to accept `BEGIN`/`ROLLBACK` without honoring the rollback, and has no row-level locking. A file-backed SQLite alternative was proposed and declined for the same class of reason — its database-level write lock cannot reproduce the READ COMMITTED semantics the guards depend on. Tests now run against real Postgres in an isolated schema. Full reasoning in Appendix A.3.
14. **A refund must release what the order was holding.** Refunding money and freeing the reservation that money was paying for are one operation, not two. `issue_refund` originally did the first and not the second, which meant a refund on an order with a live hold left the units reserved permanently. The general principle: a write tool that ends an order's lifecycle is responsible for every resource that order had claimed, and must do it in the same transaction — otherwise a partial failure leaves the two halves disagreeing.

---

## 6. Client Review Rounds

### Round one — architecture

| Requested | Outcome |
|---|---|
| Persist state and audit history across restarts | Migrated from in-memory SQLite to hosted Supabase Postgres; `pg` driver, extracted DDL, standalone seed script, async data-access layer with explicit transactions |
| True idempotency on write tools | `idempotency_keys` table (composite PK `tool_name, key`); both write tools require a UUID; repeat keys replay the stored result |
| Durable audit trail | `action_log` table; every write-tool call logged, success or rejection. Corrected mid-round: the audit and idempotency writes were initially decoupled from the mutation, which did not meet the requirement that the audit record share the mutation's transaction — moved inside the same `BEGIN`/`COMMIT` |
| Fix the oversell race | Stock decrement became a single atomic conditional `UPDATE … WHERE sku = $2 AND available_qty >= $1`; 0 rows aborts |
| Public deployment | Render free-tier Web Service against the Supabase pooler |

### Round two — concurrency and observability

| Requested | Outcome |
|---|---|
| **1a** — in-transaction reads must use the transaction's client | Both write methods now open the transaction first and run every read on its `client`; the pool-based shipment read became a private `getShipmentByOrderTx()` |
| **1b** — guard the order status UPDATE, not just the stock decrement | `WHERE id = $1 AND status = 'failed'` (reconfirm) and `WHERE id = $1 AND status != 'refunded'` (refund), both aborting on 0 affected rows with a "state changed since it was read — please re-investigate" error. Reproduced the two-holds-on-one-order defect before fixing it |
| **1c** — a genuine concurrent test against real Postgres | Test infrastructure moved off `pg-mem` to an isolated real-Postgres schema; new 18-check concurrency suite firing genuinely simultaneous calls |
| **2** — make rejection-path log failures observable | **The premise needed correcting.** These failures were never silently swallowed — all three catch blocks already called `console.error`. The real defect was that the lines named neither the tool, the order, nor the consequence, making them untraceable in an interleaved log stream. Now tagged and identified |

**Folded in, not requested:** hold/shipment/refund IDs were `${prefix}${Date.now()}`
and collide within a single millisecond on a `TEXT PRIMARY KEY`. Replaced with
`newId(prefix)`. This collision was actively masking the 1b concurrency bug — see
Appendix A.1.

**Found and disclosed, not requested:** same-key idempotency does not replay under
genuinely simultaneous calls. Data integrity holds; the stated contract does not,
for that case. Appendix A.6.

---

## 7. Appendix A — Engineering Log

*What went wrong during implementation and how each was resolved. Retained because
several of these are the actual evidence behind the verification claims above — in
particular, two cases where a passing test turned out to prove nothing.*

### A.1 — ID collisions were masking the concurrency bug

The first guard test for Fix 1b reported PASS *before any fix was written*.

Probing the unfixed code on a fresh database showed the real behavior:

```
RECONFIRM: no error thrown
A1027 holds: ["H1027","H1785934534503"]   <-- duplicate hold created
A1027 status: confirmed
```

The concurrency bug was real and reproducible. The false PASS came from a *second*
defect: IDs were `${prefix}${Date.now()}`. Within the full suite, A1023's reconfirm
ran a few milliseconds earlier, so A1027's reconfirm generated the same
millisecond-based ID, collided on the `TEXT PRIMARY KEY`, and threw a duplicate-key
error. The test saw "an error was thrown" and scored it as the guard working.

Four assertions were green for the wrong reason. Had the implementation been
written before the test — or had the test not been run against unfixed code first —
a non-functional guard would have shipped with an all-green suite as its evidence.

**Resolution:** `newId(prefix)` → `${prefix}${Date.now()}-${uuid8}`, applied to
holds, shipments, and refunds.

### A.2 — A guard test that never reached the guard

After the ID fix, the guard test failed with `Insufficient stock for SKU SKU-202`
rather than the expected state-changed error. In `reconfirmOrder` the stock
decrement runs *before* the status flip, and the test used A1027, whose SKU-202
stock had already been consumed by A1023's reconfirm earlier in the same run. It
aborted at the stock check and never reached the code under test.

**Resolution:** switched to A1003 (`processing`, SKU-404 with stock remaining) and
added an explicit up-front assertion that stock is sufficient — so the test fails
loudly if it ever again stops exercising the guard, rather than passing at the
wrong checkpoint.

### A.3 — The test database could not verify transactions

An assertion that stock was rolled back after an aborted transaction failed.
Probing `pg-mem` directly:

```
inside txn after decrement: 9
rolled back: force abort
AFTER ROLLBACK v = 9        <-- expected 10 if ROLLBACK were honored
```

`pg-mem` accepts `BEGIN`/`ROLLBACK` without error and does not roll back. This is
materially broader than the "no MVCC" limitation already known: **every abort path
in the suite had been green without verifying that cleanup occurred.**

**Options considered:**

| Option | Verdict |
|---|---|
| Keep `pg-mem` | Rejected — cannot verify rollback or row locking, the exact properties under review |
| File-backed SQLite | Rejected — database-level write lock cannot reproduce the READ COMMITTED block-then-re-evaluate semantics the guards depend on, so a passing concurrency test would be as uninformative as `pg-mem`. Also: `BIGSERIAL`/`TIMESTAMPTZ`/`DEFAULT NOW()` have no equivalents, forcing a second schema file that would drift from the deployed one; ~75 `$N` placeholders are Postgres-style; and this project deliberately migrated *off* SQLite at client request |
| Local Postgres via Docker | Unavailable — no `docker`/`podman` on the dev machine |
| Local Postgres via `initdb` | Viable; requires a system package install |
| **Disposable schema on the existing Supabase project** | **Chosen** — a real Postgres server, nothing to install or maintain locally; accepted tradeoff of network latency per query |

**Resolution:** `src/tests/testdb.ts` pins `search_path` to a dedicated
`ops_mcp_test` schema, dropped and recreated per run. `pg-mem` removed. The
previously-impossible rollback assertion now runs and passes.

The lesson taken from this was not "pick a closer imitation" but "test against the
real engine."

### A.4 — A second assertion that was green for the wrong reason

On the first run against real Postgres, `idempotency key stored once` failed.
Postgres returns `COUNT(*)` as `bigint`, which the `pg` driver surfaces as a
**string** (bigints can exceed JS's safe integer range); `pg-mem` returned a
number. The assertion used `=== 1`, so it had only ever passed because of
`pg-mem`'s non-standard typing.

**Resolution:** cast in SQL (`COUNT(*)::int`), correct against real Postgres
regardless of driver coercion.

Two separate assertions in this codebase turned out to be passing for reasons
unrelated to what they claimed to verify, and neither was discoverable by reading
the tests — both required changing something underneath them (running against
unfixed code; swapping the database engine). The count of passing checks was never
the useful signal.

### A.5 — The reported defect was not the actual defect (Fix 2)

The client described rejection-path audit failures as "wrapped in a catch that
discards errors silently." Writing the test first showed otherwise: the checks for
"does not throw" and "the failure is logged" both passed against unmodified code.
All three catch blocks already called `console.error`.

The real defect was traceability. The old line read:

```
Failed to store idempotency result: error: duplicate key value violates ...
```

No tool, no order, no key, no consequence — untraceable in a log stream
interleaved across concurrent requests, and so *effectively* invisible even though
technically logged. The client's conclusion was right; the stated mechanism was
not.

**Resolution:** greppable tags, identifying fields, and operational meaning:

```
[idempotency-store-failed] tool=reconfirm_order key=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa
  — key was NOT stored, so a retry with this key will re-execute:
  error: duplicate key value violates unique constraint "idempotency_keys_pkey"
```

Non-blocking behavior was left unchanged and is now asserted rather than assumed.

### A.6 — Two gaps found while probing the refund path

While assessing whether the same-key race could mislead an operator into taking a
contradictory action, the probe exposed a separate and more consequential defect.

**Gap 1 — refunding an order that holds live inventory left the reservation
standing. FIXED.** Not a race: a plain precondition gap. `issue_refund` checked
only "not already refunded" and "payment captured", both true of a `confirmed` or
`shipped` order. Refunding one left its active hold in place and its stock
decrement permanent, with no shipment ever coming.

```
order_now=confirmed              (reconfirm succeeded)
refund_on_confirmed=success      (refund also succeeded)
final_status=refunded  active_holds=1  stock=11
```

Money returned, unit reserved forever. That is state corruption rather than a
violated contract, it does not self-heal, and it needed no race — any operator
could reach it at any time. `issueRefund` now releases any `status = 'active'`
hold on the order and credits the freed units back to `available_qty`, in the
same transaction as the refund. Scoped to active holds specifically, so a refund
against an already-released or expired hold cannot double-credit stock. 6 new
checks; main suite **54/54**.

**Gap 2 — same-key idempotency does not replay under genuinely simultaneous
calls. NOT FIXED, by decision.** Two `reconfirm_order` calls with the **same**
`idempotency_key`, fired simultaneously:

```
RESULT_1: {"success":true,"new_hold_id":"H1785938590195-16fa0599",...}
RESULT_2: {"error":"Order A1023 state changed since it was read
           (status is no longer 'failed'). ..."}
```

**Data integrity holds** — exactly one hold, one stock decrement, one
`idempotency_keys` row, one success audit row. Nothing double-executes.

**The gap is contractual.** The stated behavior (Decisions Log #8, and the tool
descriptions fed to the model) is "retry with the same key replays the stored
result." That holds for *sequential* retries — the realistic case, where a call
times out and the agent retries after the first has committed. It does not hold
for genuinely simultaneous same-key calls: neither request sees the other's
uncommitted idempotency row, so the loser falls through to the conditional-write
guard and receives a state-changed error instead of a replay.

**Why the two gaps are connected.** Gap 2's misleading error was the plausible
route into Gap 1: a caller told "state changed" might conclude the reconfirm
failed and issue a refund, which before the fix would have succeeded and
corrupted inventory state. With Gap 1 fixed that chain terminates safely — the
worst outcome is a refund on an order that had in fact succeeded, which is money
out but inventory correctly returned, and is visible in `action_log`.

**Why Gap 2 is left open.** The fix — catch the unique-violation on the
`idempotency_keys` INSERT, re-read, and return the stored result — is well
understood and Postgres makes it reliable (the loser blocks until the winner
commits, so the stored row is guaranteed readable by the time the error is
raised). It is deferred because it changes write-path error handling that three
consecutive fixes had just stabilised, and it deserves its own review cycle
rather than being folded in at the end of a session. It is asserted and commented
in `src/tests/concurrency.test.ts` so it cannot regress silently.

**Assessment:** low likelihood — an LLM agent retries sequentially, not in
parallel — and the corruption path it could have led to is now closed. Disclosed
here rather than left to be found, the same posture that had the 1a shipment-read
issue disclosed before the client independently confirmed it.

---

## 8. Project History

- **[Initial]** Schema/seed, data access layer, 7 MCP tools, Express + MCP SDK server with stateless Streamable HTTP transport, 14-check verification suite. Local only.
- **[2026-07-31] Postgres migration.** Replaced `better-sqlite3` with `pg`; DDL extracted to `src/db/schema.sql`; seed moved to a standalone script. All repository methods and tool handlers made async with `$1` parameterized queries and explicit `BEGIN`/`COMMIT`/`ROLLBACK`. 14/14 passing.
- **[2026-07-31] Live Supabase deployment.** Schema + seed deployed to a live instance via the ap-southeast-2 pooler endpoint, resolving an IPv6-connectivity limitation. Verified end-to-end against the live DB.
- **[2026-07-31] Public deployment on Render.** `https://ops-mcp.onrender.com`; postbuild copies `schema.sql` into `dist/db/`. Verified live: `/health`, MCP handshake over HTTPS, and a `tools/call` returning correct data for A1023 — confirming state persisted across the whole chain.
- **[2026-08-01] Audit log, idempotency keys, oversell fix, transactional coupling.** Added `action_log` and `idempotency_keys`. Oversell fixed via atomic conditional stock decrement. **Follow-up correction:** the audit and idempotency writes were initially best-effort and decoupled from the mutation, which did not meet the client's requirement that an approved mutation's audit record share its transaction — moved inside the same transaction. 30/30 local, 11/11 live.
- **[2026-08-01] Seed script reset safety.** Added an explicit `--reset` flag for a genuine clean-slate reset, with the default (`ON CONFLICT DO NOTHING`) left safe for accidental re-runs.
- **[2026-08-01] Seed reset preserves audit history.** Excluded `action_log` from the `--reset` truncation. The audit trail is durable by design; `idempotency_keys` remains in scope, being orphaned once its mutations are gone.
- **[2026-08-05] Concurrent write guards + ID collisions** (`d91e6e1`). Transaction-scoped reads in both write methods; conditional status UPDATEs aborting on 0 affected rows; `newId()` replacing millisecond-based IDs. The two-holds-on-one-order defect was reproduced before being fixed, and the ID collision was found to be masking it (Appendix A.1).
- **[2026-08-05] Real-Postgres test infrastructure + concurrency suite** (`d13d9b4`). `pg-mem` removed after being found not to honor `ROLLBACK`. Tests moved to an isolated `ops_mcp_test` schema on real Postgres. New 18-check concurrency suite verifying the guards under genuine contention. Restored the rollback assertion that had been unverifiable; fixed a `COUNT(*)` assertion that had been passing on `pg-mem`'s non-standard typing (A.3, A.4).
- **[2026-08-05] Refund releases live inventory.** `issue_refund` now releases any `status = 'active'` hold on the order and credits the freed units back to `available_qty`, inside the refund's own transaction. Found while probing whether the same-key race could mislead an operator: refunding a `confirmed` or `shipped` order previously left its reservation standing and its stock decrement permanent, with no shipment coming — phantom inventory reachable by any operator, no race required. Beyond the client's requested scope; fixed because it is a genuine hole in the safety model the project rests on. 6 new checks, main suite 54/54. See Appendix A.6.
- **[2026-08-05] Rejection-path log traceability** (`d3a43e3`). Tagged, identified log lines stating operational consequence. The reported "silent swallowing" did not exist; the real defect was untraceability (A.5).
