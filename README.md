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

## Architecture

```
AI agent (MCP client)
        │  MCP over Streamable HTTP (stateless)
        ▼
Express server (src/server.ts)
        │  registers 7 tools via @modelcontextprotocol/sdk McpServer
        ▼
Tool definitions (src/tools/definitions.ts)
        │  each tool: name, AI-facing description, zod input shape, handler
        ▼
Data access layer (src/db/queries.ts) — OpsRepository class (all SQL lives here)
        ▼
Hosted PostgreSQL (Supabase)
```

All state lives in the Postgres database, and the MCP transport is stateless —
a fresh `McpServer` + transport per request. This keeps hosting simple (no
sticky sessions needed) with no downside, since there is no server-side
session state to preserve.

## Data

Hosted PostgreSQL, seeded once via `npm run seed`. Set the `DATABASE_URL`
environment variable (see `.env.example`) to point at your Postgres instance
(e.g. Supabase, Neon, or a local Docker container). The schema is defined in
`src/db/schema.sql`; seed data lives in `src/db/seed.ts` and uses
`INSERT ... ON CONFLICT DO NOTHING` for idempotent re-seeding. 10 orders
are seeded, covering: normal happy-path orders, the two core scenario
orders (A1023 = reconfirm path, A1024 = refund path), and three deliberate
edge cases (an already-refunded order, a cancelled order, and a "decoy"
order that looks similar but isn't actually broken).

> **Supabase pooler:** If your DB host only has IPv6 DNS (Supabase's direct
> `db.[ref].supabase.co` endpoint), use the Supabase **Connection Pooler**
> endpoint instead — it resolves to IPv4 and works from any hosting
> environment. Get it from the Supabase dashboard under Database →
> Connection Pooling. Format:
> `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres`

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

### Write-tool safety guarantees

- **Explicit operator approval** — both write tools require `confirmed_by_operator: true`,
  set only after a human approves the specific action.
- **Idempotent replay** — both write tools require an agent-generated UUID `idempotency_key`.
  Retrying with the same key replays the stored result instead of re-executing — including
  when two calls carrying that key arrive at genuinely the same instant, which a
  transaction-scoped advisory lock on the key serializes.
- **Transactional audit + idempotency** — the `action_log` row and `idempotency_keys` row are
  committed in the same transaction as the mutation; they commit or roll back together.
- **Oversell protection** — stock decrement is a single atomic conditional
  `UPDATE ... WHERE available_qty >= $N`; insufficient stock aborts and rolls back.
- **Concurrent-write guards** — every consequential `UPDATE` re-checks its precondition in the
  `WHERE` clause at write time; 0 affected rows aborts the transaction with an actionable error
  telling the operator to re-investigate before acting.
- **Refund releases inventory** — `issue_refund` releases any `status = 'active'` hold on the
  order and credits the units back to `available_qty`, in the same transaction as the refund.
  No phantom reservations standing after a refund.

Write-tool rejection paths (refunded order, no captured payment, order not `failed`)
are logged but intentionally stand alone, since there's no mutation to share a transaction with.

Full tool descriptions (including preconditions and safety notes fed to
the calling model) are in `src/tools/definitions.ts`.

## Running locally

Set up your environment first:

```bash
cp .env.example .env
# Edit .env to add your DATABASE_URL pointing at a PostgreSQL instance
# Load it: `export $(cat .env | xargs)` or use a .env loader
npm run seed  # one-time: creates tables and inserts seed data
```

**Default (no flags):** seed data is inserted with `ON CONFLICT DO NOTHING` —
safe to re-run on a live database; it will **not** overwrite or undo mutations
an agent may have made (e.g. an order reconfirmed from `failed` to `confirmed`
stays confirmed).

**To reset demo/business state** (truncate business tables and re-seed from
scratch, **preserving the audit log**):

```bash
npm run seed -- --reset
```

The `--reset` flag truncates `inventory_stock`, `inventory_holds`, `shipments`,
`payments`, and `orders` (resetting all business state to clean demo data) plus
`idempotency_keys` (meaningless without their associated mutations). The
`action_log` audit trail is **intentionally preserved** — it is a durable
historical record by design, and should survive a business-state reset.

Then:

```
npm install
npm run dev       # starts the MCP server on :3000 with tsx (no build step)
```

Health check: `GET http://localhost:3000/health`
MCP endpoint: `POST http://localhost:3000/mcp`

## Running the tests

Tests run against a **real PostgreSQL instance**, in a dedicated schema that the
harness drops and recreates on every run:

```
npm test                  # 54 checks: tools, safety rejections, audit,
                          # idempotency, concurrency guards, inventory release
npm run test:concurrency  # 26 checks: genuinely simultaneous write attempts,
                          # including same-key replay under real contention
npm run test:all          # both suites
```

Both suites call the tool handlers directly, so neither crosses the wire. For
protocol-level coverage — Express routing, `McpServer` registration, and the
Streamable HTTP transport — run the smoke script against a live server:

```
node scripts/mcp-smoke.mjs                                   # localhost:3000
node scripts/mcp-smoke.mjs https://ops-mcp.onrender.com/mcp  # deployed
```

It uses the official MCP SDK client, so it fails on what a real client would
trip over. Read-only — it never calls a write tool, so it is safe against a
live deployment.

Set `TEST_DATABASE_URL` to point at a Postgres instance; if unset, tests fall
back to `DATABASE_URL`. Either way the harness pins its connections to a
dedicated schema (`TEST_SCHEMA`, default `ops_mcp_test`), so business data in
`public` is never touched by a test run — including a run that fails partway
and leaves rows half-mutated.

`src/tests/tools.test.ts` calls the tool handlers directly (bypassing the
HTTP/MCP transport) and covers both resolution paths, every safety rejection,
transactional rollback, and the conditional-write guards.
`src/tests/concurrency.test.ts` fires simultaneous calls at the same order and
asserts exactly one succeeds.

> **Why not an in-memory mock?** The suite previously ran against `pg-mem`,
> which was found to accept `BEGIN`/`ROLLBACK` without actually rolling back,
> and has no row-level locking. Both properties are exactly what the write-path
> guards depend on, so every abort-path assertion was passing without verifying
> anything. See `docs/handoff.md` Appendix A.3.

### Building for deployment

```
npm run build
npm start          # runs dist/server.js, respects $PORT
```

Remember to set `DATABASE_URL` in your deployment environment.

**Platform notes:**
- **Render / Railway / Fly / Heroku** — Ideal. These run a persistent process;
  just set `DATABASE_URL` (to the Supabase pooler connection string) and
  deploy. These are recommended.
- **Vercel** — Not recommended. Vercel uses serverless functions with cold
  starts and timeouts (10–15s). MCP over Streamable HTTP works but will be
  unreliable for longer-running operations. Use Render or Railway instead.

**Render free-tier cold start:** the deployed instance sleeps after ~15 min
idle; the first request after a gap can take 30-50s. Mitigate with a periodic
keep-warm ping (e.g. a cron job hitting `/health`).

## Connecting an MCP client

The server is publicly deployed at `https://ops-mcp.onrender.com/mcp`. Point any
MCP-over-HTTP client (Streamable HTTP transport, stateless mode) at that URL —
or at `POST /mcp` on your own deployed instance.

### OpenCode

OpenCode discovers MCP servers from the `mcpServers` field in your
`.opencode/mcp.json` in the project root (already configured here), or a
`~/.opencode.json`.

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "https://ops-mcp.onrender.com/mcp"
    }
  }
}
```

In a conversation, invoke the agent directly on an order:

```
/opencode ops-mcp help me with order A1023 — customer says they were charged but the order failed
```

OpenCode will start a session with the MCP tools registered. No extra
configuration needed beyond the JSON snippet above.

### Claude Code

Claude Code reads MCP server config from the Claude Desktop config file
(`claude_desktop_config.json` on macOS/Windows, `~/.config/Claude/claude_desktop_config.json`
on Linux) or from a local `.mcp.json` in the project root (Claude Code 1.95+).

**Remote (Streamable HTTP)** — use the public deployed server:

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "https://ops-mcp.onrender.com/mcp",
      "transport": "httpStream"
    }
  }
}
```

**Local `.mcp.json`** (if you want to run the server yourself for per-project
scoping or development):

```json
{
  "mcpServers": {
    "ops-mcp": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      },
      "transport": "stdio"
    }
  }
}
```

Then in Claude Code, run:

```
/opencode ops-mcp investigate order A1023
```

or simply mention the tools in a normal prompt — Claude Code will
discover and call them automatically.

### Codex

Codex reads MCP config from `~/.codex/mcp.json` or `.codex/mcp.json` in
the project root.

**Remote (Streamable HTTP)** — use the public deployed server:

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "https://ops-mcp.onrender.com/mcp"
    }
  }
}
```

**Local stdio** (if you want to run the server yourself):

```json
{
  "mcpServers": {
    "ops-mcp": {
      "command": "node",
      "args": ["/abs/path/to/ops-mcp/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      },
      "transport": "stdio"
    }
  }
}
```

Then in a Codex task prompt:

```
Use the ops-mcp server to investigate order A1023: a customer says they were
charged but the order shows as failed. Check order details, payment status,
inventory hold, and stock. Recommend a resolution and wait for approval.
```

Codex will auto-discover the registered MCP tools and use them.

---

## License

MIT License with a commercial attribution clause — see [LICENSE](./LICENSE).
