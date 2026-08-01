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

Tests use `pg-mem` (in-memory PostgreSQL), so no external database is needed:

```
npm test
```

This runs `src/tests/tools.test.ts`, which calls the tool handlers directly
(bypassing HTTP/MCP transport) against an in-memory Postgres DB (via
`pg-mem`) and checks both resolution paths plus all safety-rejection cases.

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

## Connecting an MCP client

Point any MCP-over-HTTP client (Streamable HTTP transport, stateless mode)
at `POST /mcp` on the deployed URL.

### OpenCode

OpenCode discovers MCP servers from the `mcpServers` field in your
`~/.opencode.json` or a `.opencode.json` in your project root.

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "http://<host>:<port>/mcp"
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

**Local `.mcp.json`** (recommended for per-project scoping):

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

If the server is running remotely (Streamable HTTP), use the URL form:

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "http://<host>:<port>/mcp",
      "transport": "httpStream"
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

If the server is already running over HTTP:

```json
{
  "mcpServers": {
    "ops-mcp": {
      "url": "http://<host>:<port>/mcp"
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
