-- Schema definitions for ops-mcp PostgreSQL database.
-- Used by initDatabase() to create tables if they don't exist, and by the seed script.

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

CREATE TABLE IF NOT EXISTS action_log (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT,
  tool_name   TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  success     BOOLEAN NOT NULL,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_log_order_id_idx ON action_log(order_id, performed_at DESC);
