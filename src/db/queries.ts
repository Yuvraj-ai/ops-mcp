import type Database from "better-sqlite3";

export interface OrderRow {
  id: string;
  customer_name: string;
  status: string;
  total_amount: number;
  sku: string;
  created_at: string;
}
export interface PaymentRow {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  captured_at: string | null;
}
export interface HoldRow {
  id: string;
  order_id: string;
  sku: string;
  quantity: number;
  status: string;
  expires_at: string;
}
export interface StockRow {
  sku: string;
  available_qty: number;
}
export interface ShipmentRow {
  id: string;
  order_id: string;
  status: string;
  carrier: string | null;
  updated_at: string;
}

/** Data-access layer: every MCP tool goes through this, never raw SQL inline. */
export class OpsRepository {
  constructor(private db: Database.Database) {}

  getOrder(orderId: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as
      | OrderRow
      | undefined;
  }
  getPaymentByOrder(orderId: string): PaymentRow | undefined {
    return this.db.prepare(`SELECT * FROM payments WHERE order_id = ?`).get(orderId) as
      | PaymentRow
      | undefined;
  }
  getHoldByOrder(orderId: string): HoldRow | undefined {
    return this.db.prepare(`SELECT * FROM inventory_holds WHERE order_id = ?`).get(orderId) as
      | HoldRow
      | undefined;
  }
  getStock(sku: string): StockRow | undefined {
    return this.db.prepare(`SELECT * FROM inventory_stock WHERE sku = ?`).get(sku) as
      | StockRow
      | undefined;
  }
  getShipmentByOrder(orderId: string): ShipmentRow | undefined {
    return this.db.prepare(`SELECT * FROM shipments WHERE order_id = ?`).get(orderId) as
      | ShipmentRow
      | undefined;
  }

  reconfirmOrder(orderId: string): { newHoldId: string } {
    const order = this.getOrder(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    const hold = this.getHoldByOrder(orderId);
    if (!hold) throw new Error(`No inventory hold record found for ${orderId}`);

    const newHoldId = `H${Date.now()}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE inventory_stock SET available_qty = available_qty - ? WHERE sku = ?`)
        .run(hold.quantity, hold.sku);
      this.db
        .prepare(
          `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES (?, ?, ?, ?, 'active', ?)`
        )
        .run(newHoldId, orderId, hold.sku, hold.quantity, expiresAt);
      this.db.prepare(`UPDATE orders SET status = 'confirmed' WHERE id = ?`).run(orderId);

      const existingShipment = this.getShipmentByOrder(orderId);
      if (existingShipment) {
        this.db
          .prepare(`UPDATE shipments SET status = 'pending', updated_at = ? WHERE order_id = ?`)
          .run(new Date().toISOString(), orderId);
      } else {
        this.db
          .prepare(
            `INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES (?, ?, 'pending', NULL, ?)`
          )
          .run(`S${Date.now()}`, orderId, new Date().toISOString());
      }
    });
    tx();
    return { newHoldId };
  }

  issueRefund(orderId: string): { refundId: string } {
    const payment = this.getPaymentByOrder(orderId);
    if (!payment) throw new Error(`No payment record found for ${orderId}`);
    const refundId = `R${Date.now()}`;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE payments SET status = 'refunded' WHERE order_id = ?`).run(orderId);
      this.db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(orderId);
    });
    tx();
    return { refundId };
  }
}
