# PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace in-memory SQLite with hosted PostgreSQL (Supabase) using the `pg` driver, with a separate seed script that runs once/on-demand rather than on every process boot. All `OpsRepository` methods become async.

**Architecture:** A shared `pg.Pool` is created once at server startup and passed to `OpsRepository`. Schema DDL lives in `src/db/schema.sql`. Seed data is applied via a standalone `seed` script (`npm run seed`) using `ON CONFLICT DO NOTHING` for idempotency. All tool handlers become `async` and `await` repository calls. Tests are updated to be async and reset the database (drop+recreate tables + reseed) before each run. Credentials are stored in `.env` (gitignored) with a `.env.example` checked in for reference.

**Tech Stack:** `pg` (PostgreSQL driver), `@types/pg`, Supabase PostgreSQL (hosted)

---

### Task 0: Set up credentials files

**Files:**
- Create: `.env` (gitignored)
- Create: `.env.example`
- Modify: `.gitignore` (ensure `.env` is listed)

`.env.example`:
```
DATABASE_URL=postgresql://postgres:[password]@[project-ref].supabase.co:5432/postgres
```

`.env`:
```
DATABASE_URL=postgresql://postgres:[YOUR_SUPABASE_PASSWORD]@[YOUR_PROJECT_REF].supabase.co:5432/postgres
```

- [ ] **Step 1: Create .env.example**

Write `.env.example` with placeholder `DATABASE_URL` pointing at Supabase format.

- [ ] **Step 2: Create .env** (user provides actual credentials)

Write `.env` with the real Supabase connection string. This file is gitignored.

- [ ] **Step 3: Verify .gitignore includes .env**

Check `.gitignore` has `.env` listed. Add if missing.

### Task 1: Update package.json dependencies

**Files:**
- Modify: `package.json`

Replace `better-sqlite3` and `@types/better-sqlite3` with `pg` and `@types/pg`. Add `seed` script.

```json
{
  "scripts": {
    "typecheck": "for f in src/db/*.ts src/tools/*.ts; do npx tsc --noEmit --skipLibCheck --target ES2022 --module CommonJS --moduleResolution node --esModuleInterop \"$f\" || exit 1; done",
    "start": "tsx src/server.ts",
    "dev": "tsx watch src/server.ts",
    "seed": "tsx src/db/seed.ts",
    "test": "tsx --test src/tests/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^4.19.2",
    "pg": "^8.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.10",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.2",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 1: Update package.json**

Edit `package.json`: remove `better-sqlite3` and `@types/better-sqlite3`, add `pg` and `@types/pg`, add `"seed": "tsx src/db/seed.ts"` to scripts, remove the `allowScripts` section.

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: No errors, `node_modules/pg` exists

### Task 2: Create schema.sql DDL file

**Files:**
- Create: `src/db/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  status        TEXT NOT NULL,
  total_amount  REAL NOT NULL,
  sku           TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  status      TEXT NOT NULL,
  amount      REAL NOT NULL,
  captured_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory_holds (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  status     TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_stock (
  sku           TEXT PRIMARY KEY,
  available_qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  status     TEXT NOT NULL,
  carrier    TEXT,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 1: Create schema.sql**

Write the DDL to `src/db/schema.sql`.

### Task 3: Create seed.ts standalone script

**Files:**
- Create: `src/db/seed.ts`

Exports `seedDatabase(pool: Pool)` for reuse in tests, and has a CLI entry point for `npm run seed`.

```typescript
import fs from "fs";
import path from "path";
import { Pool } from "pg";

export async function seedDatabase(pool: Pool): Promise<void> {
  const schemaPath = path.join(import.meta.dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);

  const now = Date.now();
  const iso = (offsetMinutes: number) =>
    new Date(now + offsetMinutes * 60_000).toISOString();

  const queries = [
    `INSERT INTO inventory_stock (sku, available_qty) VALUES ('SKU-101', 0) ON CONFLICT (sku) DO NOTHING`,
    `INSERT INTO inventory_stock (sku, available_qty) VALUES ('SKU-202', 12) ON CONFLICT (sku) DO NOTHING`,
    `INSERT INTO inventory_stock (sku, available_qty) VALUES ('SKU-303', 25) ON CONFLICT (sku) DO NOTHING`,
    `INSERT INTO inventory_stock (sku, available_qty) VALUES ('SKU-404', 8) ON CONFLICT (sku) DO NOTHING`,
    `INSERT INTO inventory_stock (sku, available_qty) VALUES ('SKU-505', 3) ON CONFLICT (sku) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1001', 'Riya Sharma', 'delivered', 1499, 'SKU-303', '${iso(-10000)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1001', 'A1001', 'captured', 1499, '${iso(-9990)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1001', 'A1001', 'SKU-303', 1, 'released', '${iso(-9000)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES ('S1001', 'A1001', 'delivered', 'BlueDart', '${iso(-500)}') ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1023', 'Rohan Gupta', 'failed', 2499, 'SKU-202', '${iso(-120)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1023', 'A1023', 'captured', 2499, '${iso(-119)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1023', 'A1023', 'SKU-202', 1, 'expired', '${iso(-60)}') ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1024', 'Sneha Patil', 'failed', 1799, 'SKU-101', '${iso(-150)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1024', 'A1024', 'captured', 1799, '${iso(-149)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1024', 'A1024', 'SKU-101', 1, 'expired', '${iso(-90)}') ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1025', 'Arjun Nair', 'refunded', 999, 'SKU-303', '${iso(-5000)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1025', 'A1025', 'refunded', 999, '${iso(-4990)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1025', 'A1025', 'SKU-303', 1, 'released', '${iso(-4900)}') ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1026', 'Meera Iyer', 'cancelled', 1299, 'SKU-404', '${iso(-2000)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1026', 'A1026', 'authorized', 1299, null) ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1026', 'A1026', 'SKU-404', 1, 'released', '${iso(-1900)}') ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES ('A1027', 'Farhan Ali', 'confirmed', 1599, 'SKU-202', '${iso(-15)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES ('P1027', 'A1027', 'captured', 1599, '${iso(-14)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ('H1027', 'A1027', 'SKU-202', 1, 'active', '${iso(45)}') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES ('S1027', 'A1027', 'pending', null, '${iso(-14)}') ON CONFLICT (id) DO NOTHING`,
  ];

  for (const query of queries) {
    await pool.query(query);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  seedDatabase(pool)
    .then(() => {
      console.log("Database seeded successfully.");
      return pool.end();
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      pool.end();
      process.exit(1);
    });
}
```

- [ ] **Step 1: Create seed.ts**

Write the full seed script with all 10 orders' data.

- [ ] **Step 2: Test seed script**

Run: `npm run seed` (with `.env` loaded)
Expected: "Database seeded successfully."

### Task 4: Rewrite schema.ts to use pg

**Files:**
- Modify: `src/db/schema.ts`

```typescript
import fs from "fs";
import path from "path";
import { Pool } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ops_mcp";

export function createPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL });
}

export async function initDatabase(pool: Pool): Promise<void> {
  const schemaPath = path.join(import.meta.dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}
```

- [ ] **Step 1: Rewrite schema.ts**

Replace the entire file with the pg-based version. Remove `better-sqlite3` import.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --skipLibCheck src/db/schema.ts`
Expected: No errors

### Task 5: Rewrite queries.ts to use pg (async)

**Files:**
- Modify: `src/db/queries.ts`

All methods become `async`, use `pool.query()` with `$1`-style placeholders, transactions use `BEGIN`/`COMMIT`/`ROLLBACK`.

```typescript
import type { Pool } from "pg";

export interface OrderRow { ... }  // unchanged
export interface PaymentRow { ... }  // unchanged
export interface HoldRow { ... }  // unchanged
export interface StockRow { ... }  // unchanged
export interface ShipmentRow { ... }  // unchanged

export class OpsRepository {
  constructor(private pool: Pool) {}

  async getOrder(orderId: string): Promise<OrderRow | undefined> {
    const result = await this.pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    return result.rows[0] as OrderRow | undefined;
  }

  async getPaymentByOrder(orderId: string): Promise<PaymentRow | undefined> {
    const result = await this.pool.query("SELECT * FROM payments WHERE order_id = $1", [orderId]);
    return result.rows[0] as PaymentRow | undefined;
  }

  async getHoldByOrder(orderId: string): Promise<HoldRow | undefined> {
    const result = await this.pool.query("SELECT * FROM inventory_holds WHERE order_id = $1", [orderId]);
    return result.rows[0] as HoldRow | undefined;
  }

  async getStock(sku: string): Promise<StockRow | undefined> {
    const result = await this.pool.query("SELECT * FROM inventory_stock WHERE sku = $1", [sku]);
    return result.rows[0] as StockRow | undefined;
  }

  async getShipmentByOrder(orderId: string): Promise<ShipmentRow | undefined> {
    const result = await this.pool.query("SELECT * FROM shipments WHERE order_id = $1", [orderId]);
    return result.rows[0] as ShipmentRow | undefined;
  }

  async reconfirmOrder(orderId: string): Promise<{ newHoldId: string }> {
    const order = await this.getOrder(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    const hold = await this.getHoldByOrder(orderId);
    if (!hold) throw new Error(`No inventory hold record found for ${orderId}`);

    const newHoldId = `H${Date.now()}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE inventory_stock SET available_qty = available_qty - $1 WHERE sku = $2",
        [hold.quantity, hold.sku]
      );
      await client.query(
        "INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ($1, $2, $3, $4, 'active', $5)",
        [newHoldId, orderId, hold.sku, hold.quantity, expiresAt]
      );
      await client.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [orderId]);

      const existingShipment = await this.getShipmentByOrder(orderId);
      if (existingShipment) {
        await client.query(
          "UPDATE shipments SET status = 'pending', updated_at = $1 WHERE order_id = $2",
          [new Date().toISOString(), orderId]
        );
      } else {
        await client.query(
          "INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES ($1, $2, 'pending', NULL, $3)",
          [`S${Date.now()}`, orderId, new Date().toISOString()]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { newHoldId };
  }

  async issueRefund(orderId: string): Promise<{ refundId: string }> {
    const payment = await this.getPaymentByOrder(orderId);
    if (!payment) throw new Error(`No payment record found for ${orderId}`);
    const refundId = `R${Date.now()}`;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE payments SET status = 'refunded' WHERE order_id = $1", [orderId]);
      await client.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [orderId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { refundId };
  }
}
```

- [ ] **Step 1: Rewrite queries.ts**

Replace the entire file with the pg-based async version.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --skipLibCheck src/db/queries.ts`
Expected: No errors

### Task 6: Update tool definitions for async handlers

**Files:**
- Modify: `src/tools/definitions.ts`

Every handler becomes `async` and `await`s the repo call.

```typescript
handler: async (input: { order_id: string }) => {
  const order = await repo.getOrder(input.order_id);
  if (!order) return { error: `No order found with ID ${input.order_id}.` };
  return order;
},
```

Repeat for all 7 handlers — add `async` keyword and `await` before each `repo.*` call.

- [ ] **Step 1: Update all 7 handlers to async**

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --skipLibCheck src/tools/definitions.ts`
Expected: No errors

### Task 7: Update server.ts for pg connection

**Files:**
- Modify: `src/server.ts`

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPool, initDatabase } from "./db/schema.js";
import { OpsRepository } from "./db/queries.js";
import { buildToolDefinitions } from "./tools/definitions.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const pool = createPool();
initDatabase(pool).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

const repo = new OpsRepository(pool);
const toolDefs = buildToolDefinitions(repo);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ops-mcp", version: "1.0.0" });

  for (const tool of toolDefs) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema as any },
      async (args: any) => {
        const result = await tool.handler(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
  return server;
}

// ... rest unchanged (Express app, /mcp, /health, listen)
```

- [ ] **Step 1: Update server.ts**

- [ ] **Step 2: Verify server starts**

Run: `npm run dev`
Expected: Server starts, logs "ops-mcp server listening on port 3000"

- [ ] **Step 3: Verify health endpoint**

Run: `curl -s http://localhost:3000/health`
Expected: JSON with status ok and all 7 tools

### Task 8: Update tests for async + Postgres

**Files:**
- Modify: `src/tests/tools.test.ts`

```typescript
import { createPool, initDatabase } from "../db/schema.js";
import { OpsRepository } from "../db/queries.js";
import { buildToolDefinitions } from "../tools/definitions.js";
import { seedDatabase } from "../db/seed.js";
import type { Pool } from "pg";

async function resetDatabase(pool: Pool) {
  await pool.query(`
    DROP TABLE IF EXISTS shipments;
    DROP TABLE IF EXISTS inventory_holds;
    DROP TABLE IF EXISTS inventory_stock;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS orders;
  `);
  await initDatabase(pool);
  await seedDatabase(pool);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

async function run() {
  const pool = createPool();
  await resetDatabase(pool);
  const repo = new OpsRepository(pool);
  const tools = buildToolDefinitions(repo);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // All handler calls become `await`
  const order1 = await byName.get_order_details.handler({ order_id: "A1023" }) as any;
  check("order starts as failed", order1.status === "failed");

  // ... (all other test assertions with await)

  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run();
```

- [ ] **Step 1: Update tests to async**

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: 14/14 passing

### Task 9: Update README

**Files:**
- Modify: `README.md`

Update:
- "In-memory SQLite, fully reseeded on every process boot" → "Hosted PostgreSQL (Supabase), seeded once via `npm run seed`"
- Add `DATABASE_URL` env var documentation
- Add `npm run seed` instructions
- Add `.env` setup instructions

- [ ] **Step 1: Update README**

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: 14/14 passing

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Start server and test endpoints**

Run: `npm run dev`
Then: `curl -s http://localhost:3000/health`
Expected: JSON with status ok and all 7 tools

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: migrate from in-memory SQLite to hosted PostgreSQL"
```
