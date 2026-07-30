/**
 * Schema + seed data for the ops-mcp demo database.
 *
 * Design decision: in-memory SQLite (":memory:"), fully reseeded on every
 * process boot. This is deliberate, not a shortcut:
 *   - No external DB to host/connect to (the Node process IS the whole
 *     "hosted MCP server" - no separate DB hosting/connection string).
 *   - Every evaluator/tester gets an identical, reproducible dataset,
 *     regardless of what previous test runs did to the data.
 *   - We don't need cross-restart persistence for a demo workflow.
 */
import Database from "better-sqlite3";

export function createDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE orders (
      id            TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      status        TEXT NOT NULL,
      total_amount  REAL NOT NULL,
      sku           TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE payments (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      status      TEXT NOT NULL,
      amount      REAL NOT NULL,
      captured_at TEXT
    );

    CREATE TABLE inventory_holds (
      id         TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL REFERENCES orders(id),
      sku        TEXT NOT NULL,
      quantity   INTEGER NOT NULL,
      status     TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE inventory_stock (
      sku           TEXT PRIMARY KEY,
      available_qty INTEGER NOT NULL
    );

    CREATE TABLE shipments (
      id         TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL REFERENCES orders(id),
      status     TEXT NOT NULL,
      carrier    TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  seed(db);
  return db;
}

function seed(db: Database.Database) {
  const now = Date.now();
  const iso = (offsetMinutes: number) =>
    new Date(now + offsetMinutes * 60_000).toISOString();

  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (id, order_id, status, amount, captured_at) VALUES (?, ?, ?, ?, ?)`
  );
  const insertHold = db.prepare(
    `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertStock = db.prepare(
    `INSERT INTO inventory_stock (sku, available_qty) VALUES (?, ?)`
  );
  const insertShipment = db.prepare(
    `INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES (?, ?, ?, ?, ?)`
  );

  insertStock.run("SKU-101", 0);
  insertStock.run("SKU-202", 12);
  insertStock.run("SKU-303", 25);
  insertStock.run("SKU-404", 8);
  insertStock.run("SKU-505", 3);

  insertOrder.run("A1001", "Riya Sharma", "delivered", 1499, "SKU-303", iso(-10000));
  insertPayment.run("P1001", "A1001", "captured", 1499, iso(-9990));
  insertHold.run("H1001", "A1001", "SKU-303", 1, "released", iso(-9000));
  insertShipment.run("S1001", "A1001", "delivered", "BlueDart", iso(-500));

  insertOrder.run("A1002", "Karan Mehta", "shipped", 2199, "SKU-303", iso(-4000));
  insertPayment.run("P1002", "A1002", "captured", 2199, iso(-3990));
  insertHold.run("H1002", "A1002", "SKU-303", 1, "released", iso(-3000));
  insertShipment.run("S1002", "A1002", "shipped", "Delhivery", iso(-100));

  insertOrder.run("A1003", "Ayesha Khan", "processing", 899, "SKU-404", iso(-800));
  insertPayment.run("P1003", "A1003", "captured", 899, iso(-790));
  insertHold.run("H1003", "A1003", "SKU-404", 1, "released", iso(-700));
  insertShipment.run("S1003", "A1003", "processing", "Delhivery", iso(-50));

  insertOrder.run("A1004", "Vikram Rao", "confirmed", 3499, "SKU-404", iso(-200));
  insertPayment.run("P1004", "A1004", "captured", 3499, iso(-190));
  insertHold.run("H1004", "A1004", "SKU-404", 1, "active", iso(60));
  insertShipment.run("S1004", "A1004", "pending", null, iso(-190));

  insertOrder.run("A1005", "Neha Joshi", "placed", 599, "SKU-505", iso(-30));
  insertPayment.run("P1005", "A1005", "authorized", 599, null);
  insertHold.run("H1005", "A1005", "SKU-505", 1, "active", iso(30));
  insertShipment.run("S1005", "A1005", "pending", null, iso(-30));

  insertOrder.run("A1023", "Rohan Gupta", "failed", 2499, "SKU-202", iso(-120));
  insertPayment.run("P1023", "A1023", "captured", 2499, iso(-119));
  insertHold.run("H1023", "A1023", "SKU-202", 1, "expired", iso(-60));

  insertOrder.run("A1024", "Sneha Patil", "failed", 1799, "SKU-101", iso(-150));
  insertPayment.run("P1024", "A1024", "captured", 1799, iso(-149));
  insertHold.run("H1024", "A1024", "SKU-101", 1, "expired", iso(-90));

  insertOrder.run("A1025", "Arjun Nair", "refunded", 999, "SKU-303", iso(-5000));
  insertPayment.run("P1025", "A1025", "refunded", 999, iso(-4990));
  insertHold.run("H1025", "A1025", "SKU-303", 1, "released", iso(-4900));

  insertOrder.run("A1026", "Meera Iyer", "cancelled", 1299, "SKU-404", iso(-2000));
  insertPayment.run("P1026", "A1026", "authorized", 1299, null);
  insertHold.run("H1026", "A1026", "SKU-404", 1, "released", iso(-1900));

  insertOrder.run("A1027", "Farhan Ali", "confirmed", 1599, "SKU-202", iso(-15));
  insertPayment.run("P1027", "A1027", "captured", 1599, iso(-14));
  insertHold.run("H1027", "A1027", "SKU-202", 1, "active", iso(45));
  insertShipment.run("S1027", "A1027", "pending", null, iso(-14));
}
