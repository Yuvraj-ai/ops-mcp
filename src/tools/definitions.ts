import { z } from "zod";
import type { OpsRepository } from "../db/queries.js";

const orderIdShape = {
  order_id: z.string().describe("The order ID, e.g. 'A1023'"),
};

export function buildToolDefinitions(repo: OpsRepository) {
  return [
    {
      name: "get_order_details",
      description:
        "Fetch the current state of an order by ID: status, customer, amount, SKU, and " +
        "creation time. Always call this first when investigating any order-related issue " +
        "raised by an operations user. Read-only - safe to call any number of times.",
      inputSchema: orderIdShape,
      handler: (input: { order_id: string }) => {
        const order = repo.getOrder(input.order_id);
        if (!order) return { error: `No order found with ID ${input.order_id}.` };
        return order;
      },
    },
    {
      name: "get_payment_status",
      description:
        "Fetch the payment record linked to an order - whether it was authorized, captured, " +
        "failed, or refunded, and when. Use this to check whether a customer was actually " +
        "charged. Read-only - safe to call repeatedly.",
      inputSchema: orderIdShape,
      handler: (input: { order_id: string }) => {
        const payment = repo.getPaymentByOrder(input.order_id);
        if (!payment) return { error: `No payment record found for order ${input.order_id}.` };
        return payment;
      },
    },
    {
      name: "get_inventory_hold_status",
      description:
        "Fetch the inventory reservation ('hold') tied to an order: which SKU, quantity, " +
        "whether the hold is active/expired/released, and its expiry timestamp. An expired " +
        "hold on an otherwise-paid order is a common root cause of 'charged but order failed' " +
        "tickets. Read-only.",
      inputSchema: orderIdShape,
      handler: (input: { order_id: string }) => {
        const hold = repo.getHoldByOrder(input.order_id);
        if (!hold) return { error: `No inventory hold record found for order ${input.order_id}.` };
        return hold;
      },
    },
    {
      name: "check_stock_availability",
      description:
        "Check current real stock for a SKU and whether enough units are available for a " +
        "requested quantity. ALWAYS call this before recommending reconfirm_order vs " +
        "issue_refund for a failed-but-paid order - the recommendation depends entirely on " +
        "this result. Read-only.",
      inputSchema: {
        sku: z.string().describe("The SKU to check, e.g. 'SKU-202'"),
        quantity: z.number().int().positive().describe("Quantity needed"),
      },
      handler: (input: { sku: string; quantity: number }) => {
        const stock = repo.getStock(input.sku);
        if (!stock) return { error: `No stock record found for SKU ${input.sku}.` };
        return {
          sku: stock.sku,
          available_qty: stock.available_qty,
          sufficient: stock.available_qty >= input.quantity,
        };
      },
    },
    {
      name: "get_shipment_status",
      description:
        "Fetch shipment/fulfillment state for an order (status, carrier, last update). Call " +
        "this once after reconfirm_order succeeds to verify the order actually entered the " +
        "fulfillment pipeline correctly before reporting success to the operations user. " +
        "Read-only.",
      inputSchema: orderIdShape,
      handler: (input: { order_id: string }) => {
        const shipment = repo.getShipmentByOrder(input.order_id);
        if (!shipment) {
          return {
            info: `No shipment record exists yet for order ${input.order_id}. This is expected if the order has not been confirmed.`,
          };
        }
        return shipment;
      },
    },
    {
      name: "reconfirm_order",
      description:
        "Re-reserves stock and moves a failed order to 'confirmed', unblocking fulfillment. " +
        "PRECONDITIONS you must satisfy before calling this: (1) the order status is 'failed' " +
        "with a captured payment and an expired hold - confirm via get_order_details, " +
        "get_payment_status, get_inventory_hold_status; (2) check_stock_availability shows " +
        "sufficient stock; (3) the operations user has explicitly approved THIS SPECIFIC " +
        "action in the conversation. Only call with confirmed_by_operator=true once approval " +
        "is given. This tool will reject orders that are refunded or cancelled. After success, " +
        "call get_shipment_status once to verify the order entered fulfillment correctly.",
      inputSchema: {
        order_id: z.string(),
        confirmed_by_operator: z
          .literal(true)
          .describe(
            "Must be explicitly true. Only set this after the human operator has approved this exact action."
          ),
      },
      handler: (input: { order_id: string; confirmed_by_operator: true }) => {
        const order = repo.getOrder(input.order_id);
        if (!order) return { error: `No order found with ID ${input.order_id}.` };
        if (order.status === "refunded" || order.status === "cancelled") {
          return { error: `Order ${input.order_id} is '${order.status}' and cannot be reconfirmed.` };
        }
        if (order.status !== "failed") {
          return {
            error: `Order ${input.order_id} has status '${order.status}', not 'failed'. Reconfirm is only valid for failed orders. Re-investigate before acting.`,
          };
        }
        const result = repo.reconfirmOrder(input.order_id);
        return {
          success: true,
          new_order_status: "confirmed",
          new_hold_id: result.newHoldId,
          note: "Call get_shipment_status next to verify fulfillment picked this up.",
        };
      },
    },
    {
      name: "issue_refund",
      description:
        "Issues a refund against an order's captured payment. HIGH RISK - this is customer-" +
        "money-affecting and irreversible in this system. ONLY call this after the operations " +
        "user has explicitly approved THIS SPECIFIC refund in the current conversation. Only " +
        "call with confirmed_by_operator=true once that approval is given. This tool will " +
        "reject orders that are already refunded.",
      inputSchema: {
        order_id: z.string(),
        amount: z.number().positive().describe("Refund amount - should match the order total"),
        reason: z.string().describe("Short reason for the refund, for audit purposes"),
        confirmed_by_operator: z
          .literal(true)
          .describe(
            "Must be explicitly true. Only set this after the human operator has approved this exact refund."
          ),
      },
      handler: (input: {
        order_id: string;
        amount: number;
        reason: string;
        confirmed_by_operator: true;
      }) => {
        const order = repo.getOrder(input.order_id);
        if (!order) return { error: `No order found with ID ${input.order_id}.` };
        if (order.status === "refunded") {
          return { error: `Order ${input.order_id} has already been refunded.` };
        }
        const payment = repo.getPaymentByOrder(input.order_id);
        if (!payment || payment.status !== "captured") {
          return {
            error: `Order ${input.order_id} has no captured payment to refund (payment status: ${payment?.status ?? "none"}).`,
          };
        }
        const result = repo.issueRefund(input.order_id);
        return {
          success: true,
          refund_id: result.refundId,
          new_order_status: "refunded",
          reason: input.reason,
        };
      },
    },
  ];
}

export type ToolDefinition = ReturnType<typeof buildToolDefinitions>[number];
