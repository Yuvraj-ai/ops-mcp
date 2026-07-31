# Project Memory

## Session Rules

1. **Start of session**: Read this `memory.md` file first, then `docs/handoff.md`
2. **Implementation policy**: Every implementation MUST be unit tested before moving to the next task
3. **Knowledge capture**: Add important findings, patterns, and lessons learned as they are discovered
4. **Handoff.md is source of truth**: All architecture, decisions, and pending work live in `docs/handoff.md`
5. **Do not start new tasks without explicit user approval** — user must confirm before proceeding with any new task from the pending changes list

## Current Project Context

- Project: `ops-mcp`
- Path: `/home/imyuvi/projects/ops-mcp`
- Type: Node.js/TypeScript MCP server (AI-native commerce-ops tool)
- Purpose: An AI agent investigates customer order/payment/inventory issues, recommends fixes, gets human approval, executes, and verifies

## Project Architecture

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
Data access layer (src/db/queries.ts) — OpsRepository class
        ▼
SQLite/PostgreSQL (src/db/schema.ts)
```

## Key Rules

- **Read tools**: no side effects, freely re-callable, no approval gate
- **Write tools** (`reconfirm_order`, `issue_refund`): require `confirmed_by_operator: true` — deliberate safety guardrail
- **Idempotency**: Write tools require `idempotency_key` (agent-generated, reuse on retry)
- **Verification**: After `reconfirm_order`, call `get_shipment_status` to verify write took effect
- **No search_orders tool**: Workflow always starts from known order ID (by design)
- **All SQL in data access layer**: Never inline in tool handlers

## Pending Changes (from handoff.md)

1. [x] Migrate from in-memory SQLite to hosted PostgreSQL — DONE: `pg` driver, `pg-mem` for tests, schema.sql DDL, seed.ts standalone script, all async. Tests pass 14/14.
2. [x] Deploy schema + seed to live Supabase — DONE: ap-southeast-2 pooler endpoint, all 10 orders + 5 stock items verified. End-to-end test passes.
3. [x] Add audit log (`action_log` table) — DONE: table in schema.sql, `logAction()` in OpsRepository, both write handlers wrapped. 17/17 tests pass + verified against live Supabase.
4. [ ] Add true idempotency via agent-generated key (Option A — locked)
5. [ ] Fix oversell race condition in `reconfirm_order` (atomic conditional UPDATE)
6. [ ] Audit hold/stock mutations are correctly scoped by order_id/hold id
7. [x] Re-run full verification suite — DONE: 17/17 pg-mem tests + live Supabase e2e test both pass
8. [x] Update README for Postgres setup — DONE: pooler guidance, platform notes (Heroku/Render/Vercel)
9. [~] Deployment — Infrastructure ready (.env with pooler connection string); hosting platform deployment awaiting user approval

## Seed Data Reference

| order_id | customer | order.status | payment.status | hold.status | Purpose |
|---|---|---|---|---|---|
| A1001 | Riya Sharma | delivered | captured | released | happy path |
| A1002 | Karan Mehta | shipped | captured | released | happy path |
| A1023 | Rohan Gupta | failed | captured | expired | Core scenario Path B: reconfirm |
| A1024 | Sneha Patil | failed | captured | expired | Core scenario Path A: refund |
| A1025 | Arjun Nair | refunded | refunded | released | edge: already resolved |
| A1026 | Meera Iyer | cancelled | authorized (never captured) | released | edge: no refund possible |
| A1027 | Farhan Ali | confirmed | captured | active | decoy: looks similar but isn't broken |

## Decisions Log (Key Rationale)

1. In-memory SQLite → hosted PostgreSQL (client requirement: persisted audit history)
2. Supabase pooler endpoint for IPv4 accessibility — direct DB host is IPv6-only, pooler resolves to IPv4
3. SSL with `rejectUnauthorized: false` for Supabase connections (pooler uses self-signed certs)
4. Explicit `confirmed_by_operator: true` flag (safety mechanism, not just model judgment)
5. No `search_orders` tool (workflow always starts from known order ID)
6. Idempotency: agent-generated key, server replays stored result on match (Stripe/PayPal pattern)
7. Oversell protection: atomic conditional UPDATE, not separate check-then-write

## Test Status

- Current: 14/14 tests passing
- All 5 read tools verified
- Full diagnostic chain on A1023 verified
- Safety rejections verified (refunded order, no captured payment, decoy order)
- End-to-end live integration test against Supabase PostgreSQL passes (reconfirm → shipment verify)

## TODO

<!-- Track ongoing items and decisions -->