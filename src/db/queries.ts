import type { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";

/**
 * Collision-free ID generator.
 *
 * IDs were previously `${prefix}${Date.now()}`, which collides when two writes
 * land in the same millisecond — these are TEXT PRIMARY KEYs, so a collision
 * aborts the transaction with a duplicate-key error.
 */
export function newId(prefix: string): string {
  return `${prefix}${Date.now()}-${randomUUID().slice(0, 8)}`;
}


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
      // Non-blocking by design: this runs on the rejection path, where the
      // transaction has already rolled back, so a failure here must not change
      // the user-facing response. It must still be diagnosable from the log
      // alone — hence tool, order, and outcome are named explicitly.
      console.error(
        `[audit-write-failed] tool=${params.tool_name} order=${params.order_id ?? "none"} ` +
          `success=${params.success} — audit row was NOT written:`,
        err
      );
    }
  }

  async getIdempotencyResult(toolName: string, key: string): Promise<any | undefined> {
    try {
      const result = await this.pool.query(
        "SELECT result FROM idempotency_keys WHERE tool_name = $1 AND key = $2",
        [toolName, key]
      );
      if (result.rows.length === 0) return undefined;
      return JSON.parse(result.rows[0].result);
    } catch (err) {
      console.error(
        `[idempotency-check-failed] tool=${toolName} key=${key} — ` +
          `proceeding as a fresh execution, so a retry may re-execute:`,
        err
      );
      return undefined;
    }
  }

  async storeIdempotencyResult(toolName: string, key: string, result: any): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO idempotency_keys (tool_name, key, result) VALUES ($1, $2, $3)",
        [toolName, key, JSON.stringify(result)]
      );
    } catch (err) {
      console.error(
        `[idempotency-store-failed] tool=${toolName} key=${key} — ` +
          `key was NOT stored, so a retry with this key will re-execute:`,
        err
      );
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

  /**
   * Same read as getShipmentByOrder, but on a caller-supplied transaction
   * client so it participates in that transaction's isolation. Never read via
   * the pool once BEGIN has been issued — a pool read runs on a different
   * connection, sees none of the transaction's own uncommitted writes, and can
   * self-deadlock if the pool is saturated.
   */
  private async getShipmentByOrderTx(
    client: PoolClient,
    orderId: string
  ): Promise<ShipmentRow | undefined> {
    const result = await client.query("SELECT * FROM shipments WHERE order_id = $1", [orderId]);
    return result.rows[0] as ShipmentRow | undefined;
  }

  async reconfirmOrder(
    orderId: string,
    idempotencyKey: string,
    inputJson: string
  ): Promise<{ success: true; new_order_status: string; new_hold_id: string; note: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Every read below runs on the transaction's own client, so the state we
      // validate is the state we mutate.
      const orderResult = await client.query("SELECT * FROM orders WHERE id = $1", [orderId]);
      const order = orderResult.rows[0] as OrderRow | undefined;
      if (!order) throw new Error(`Order ${orderId} not found`);

      const holdResult = await client.query(
        "SELECT * FROM inventory_holds WHERE order_id = $1",
        [orderId]
      );
      const hold = holdResult.rows[0] as HoldRow | undefined;
      if (!hold) throw new Error(`No inventory hold record found for ${orderId}`);

      const newHoldId = newId("H");
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

      const stockUpdate = await client.query(
        "UPDATE inventory_stock SET available_qty = available_qty - $1 WHERE sku = $2 AND available_qty >= $1",
        [hold.quantity, hold.sku]
      );
      if (stockUpdate.rowCount === 0) {
        throw new Error(
          `Insufficient stock for SKU ${hold.sku}: need ${hold.quantity}, not available`
        );
      }

      // Guarded status flip: the WHERE clause re-checks 'failed' at write time,
      // so a concurrent caller that also read 'failed' but lost the race matches
      // 0 rows here and aborts instead of creating a second hold.
      const orderUpdate = await client.query(
        "UPDATE orders SET status = 'confirmed' WHERE id = $1 AND status = 'failed'",
        [orderId]
      );
      if (orderUpdate.rowCount === 0) {
        throw new Error(
          `Order ${orderId} state changed since it was read (status is no longer 'failed'). ` +
            `No changes were made — please re-investigate before acting.`
        );
      }

      await client.query(
        "INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at) VALUES ($1, $2, $3, $4, 'active', $5)",
        [newHoldId, orderId, hold.sku, hold.quantity, expiresAt]
      );

      const existingShipment = await this.getShipmentByOrderTx(client, orderId);
      if (existingShipment) {
        await client.query(
          "UPDATE shipments SET status = 'pending', updated_at = $1 WHERE order_id = $2",
          [new Date().toISOString(), orderId]
        );
      } else {
        await client.query(
          "INSERT INTO shipments (id, order_id, status, carrier, updated_at) VALUES ($1, $2, 'pending', NULL, $3)",
          [newId("S"), orderId, new Date().toISOString()]
        );
      }
      const result = {
        success: true,
        new_order_status: "confirmed",
        new_hold_id: newHoldId,
        note: "Call get_shipment_status next to verify fulfillment picked this up.",
      } as const;
      await client.query(
        "INSERT INTO action_log (order_id, tool_name, input_json, result_json, success) VALUES ($1, $2, $3, $4, $5)",
        [orderId, "reconfirm_order", inputJson, JSON.stringify(result), true]
      );
      await client.query(
        "INSERT INTO idempotency_keys (tool_name, key, result) VALUES ($1, $2, $3)",
        ["reconfirm_order", idempotencyKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async issueRefund(
    orderId: string,
    idempotencyKey: string,
    inputJson: string,
    reason: string
  ): Promise<{ success: true; refund_id: string; new_order_status: string; reason: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const paymentResult = await client.query(
        "SELECT * FROM payments WHERE order_id = $1",
        [orderId]
      );
      const payment = paymentResult.rows[0] as PaymentRow | undefined;
      if (!payment) throw new Error(`No payment record found for ${orderId}`);

      const refundId = newId("R");

      // Guarded: only flip an order that is not already refunded. A concurrent
      // caller that lost the race matches 0 rows and aborts rather than issuing
      // a second refund against the same payment.
      const orderUpdate = await client.query(
        "UPDATE orders SET status = 'refunded' WHERE id = $1 AND status != 'refunded'",
        [orderId]
      );
      if (orderUpdate.rowCount === 0) {
        throw new Error(
          `Order ${orderId} state changed since it was read (it is already 'refunded'). ` +
            `No refund was issued — please re-investigate before acting.`
        );
      }

      await client.query(
        "UPDATE payments SET status = 'refunded' WHERE order_id = $1 AND status = 'captured'",
        [orderId]
      );

      // Release any live reservation this order still holds, and return the
      // units to available stock. Without this, refunding an order that had an
      // active hold left the reservation standing and the stock decrement
      // permanent, with no shipment ever coming — phantom reserved inventory
      // that does not self-heal.
      //
      // Scoped to status = 'active' so the credit happens once and only for a
      // genuinely live reservation: an already-released or expired hold has no
      // outstanding stock claim to give back. Both statements share this
      // transaction, so a failure anywhere rolls back the refund with them.
      const releasedHolds = await client.query(
        "UPDATE inventory_holds SET status = 'released' WHERE order_id = $1 AND status = 'active' RETURNING sku, quantity",
        [orderId]
      );
      for (const hold of releasedHolds.rows as Array<{ sku: string; quantity: number }>) {
        await client.query(
          "UPDATE inventory_stock SET available_qty = available_qty + $1 WHERE sku = $2",
          [hold.quantity, hold.sku]
        );
      }
      const result = {
        success: true,
        refund_id: refundId,
        new_order_status: "refunded",
        reason,
      } as const;
      await client.query(
        "INSERT INTO action_log (order_id, tool_name, input_json, result_json, success) VALUES ($1, $2, $3, $4, $5)",
        [orderId, "issue_refund", inputJson, JSON.stringify(result), true]
      );
      await client.query(
        "INSERT INTO idempotency_keys (tool_name, key, result) VALUES ($1, $2, $3)",
        ["issue_refund", idempotencyKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
