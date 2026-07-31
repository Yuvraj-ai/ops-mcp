import type { Pool } from "pg";

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
  constructor(private pool: Pool) {}

  async logAction(params: {
    order_id: string | null;
    tool_name: string;
    input_json: string;
    result_json: string;
    success: boolean;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO action_log (order_id, tool_name, input_json, result_json, success)
         VALUES ($1, $2, $3, $4, $5)`,
        [params.order_id, params.tool_name, params.input_json, params.result_json, params.success]
      );
    } catch (err) {
      console.error("Failed to write audit log:", err);
    }
  }

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
       const stockUpdate = await client.query(
         "UPDATE inventory_stock SET available_qty = available_qty - $1 WHERE sku = $2 AND available_qty >= $1",
         [hold.quantity, hold.sku]
       );
       if (stockUpdate.rowCount === 0) {
         throw new Error(
           `Insufficient stock for SKU ${hold.sku}: need ${hold.quantity}, not available`
         );
       }
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
