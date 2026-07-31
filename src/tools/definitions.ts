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
      handler: async (input: { order_id: string }) => {
        const order = await repo.getOrder(input.order_id);
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
      handler: async (input: { order_id: string }) => {
        const payment = await repo.getPaymentByOrder(input.order_id);
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
      handler: async (input: { order_id: string }) => {
        const hold = await repo.getHoldByOrder(input.order_id);
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
      handler: async (input: { sku: string; quantity: number }) => {
        const stock = await repo.getStock(input.sku);
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
      handler: async (input: { order_id: string }) => {
        const shipment = await repo.getShipmentByOrder(input.order_id);
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
        "call get_shipment_status once to verify the order entered fulfillment correctly. " +
        "Generate a fresh UUID for idempotency_key per logical attempt. If you retry after a " +
        "timeout or error, reuse the SAME key verbatim - the server will replay the stored " +
        "result instead of re-executing.",
      inputSchema: {
        order_id: z.string(),
        idempotency_key: z
          .string()
          .uuid()
          .describe(
            "A UUID generated by the agent for this specific attempt. Reuse on retry to get the same result without re-executing. Required."
          ),
        confirmed_by_operator: z
          .literal(true)
          .describe(
            "Must be explicitly true. Only set this after the human operator has approved this exact action."
          ),
      },
      handler: async (input: { order_id: string; idempotency_key: string; confirmed_by_operator: true }) => {
        let result: any;
        let isReplay = false;

        const existing = await repo.getIdempotencyResult("reconfirm_order", input.idempotency_key);
        if (existing) {
          result = existing;
          isReplay = true;
        } else {
          try {
            const order = await repo.getOrder(input.order_id);
            if (!order) {
              result = { error: `No order found with ID ${input.order_id}.` };
            } else if (order.status === "refunded" || order.status === "cancelled") {
              result = { error: `Order ${input.order_id} is '${order.status}' and cannot be reconfirmed.` };
            } else if (order.status !== "failed") {
              result = {
                error: `Order ${input.order_id} has status '${order.status}', not 'failed'. Re-investigate before acting.`,
              };
            } else {
              const r = await repo.reconfirmOrder(input.order_id);
              result = {
                success: true,
                new_order_status: "confirmed",
                new_hold_id: r.newHoldId,
                note: "Call get_shipment_status next to verify fulfillment picked this up.",
              };
            }
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        await repo.logAction({
          order_id: input.order_id,
          tool_name: "reconfirm_order",
          input_json: JSON.stringify(input),
          result_json: JSON.stringify(result),
          success: !("error" in result),
        });

        if (!isReplay) {
          await repo.storeIdempotencyResult("reconfirm_order", input.idempotency_key, result);
        }

        return result;
      },
    },
    {
      name: "issue_refund",
      description:
        "Issues a refund against an order's captured payment. HIGH RISK - this is customer-" +
        "money-affecting and irreversible in this system. ONLY call this after the operations " +
        "user has explicitly approved THIS SPECIFIC refund in the current conversation. Only " +
        "call with confirmed_by_operator=true once that approval is given. This tool will " +
        "reject orders that are already refunded. Generate a fresh UUID for idempotency_key " +
        "per logical attempt. If you retry after a timeout or error, reuse the SAME key " +
        "verbatim - the server will replay the stored result instead of re-executing.",
      inputSchema: {
        order_id: z.string(),
        idempotency_key: z
          .string()
          .uuid()
          .describe(
            "A UUID generated by the agent for this specific attempt. Reuse on retry to get the same result without re-executing. Required."
          ),
        amount: z.number().positive().describe("Refund amount - should match the order total"),
        reason: z.string().describe("Short reason for the refund, for audit purposes"),
        confirmed_by_operator: z
          .literal(true)
          .describe(
            "Must be explicitly true. Only set this after the human operator has approved this exact refund."
          ),
      },
      handler: async (input: {
        order_id: string;
        idempotency_key: string;
        amount: number;
        reason: string;
        confirmed_by_operator: true;
      }) => {
        let result: any;
        let isReplay = false;

        const existing = await repo.getIdempotencyResult("issue_refund", input.idempotency_key);
        if (existing) {
          result = existing;
          isReplay = true;
        } else {
          try {
            const order = await repo.getOrder(input.order_id);
            if (!order) {
              result = { error: `No order found with ID ${input.order_id}.` };
            } else if (order.status === "refunded") {
              result = { error: `Order ${input.order_id} has already been refunded.` };
            } else {
              const payment = await repo.getPaymentByOrder(input.order_id);
              if (!payment || payment.status !== "captured") {
                result = {
                  error: `Order ${input.order_id} has no captured payment to refund (payment status: ${payment?.status ?? "none"}).`,
                };
              } else {
                const r = await repo.issueRefund(input.order_id);
                result = {
                  success: true,
                  refund_id: r.refundId,
                  new_order_status: "refunded",
                  reason: input.reason,
                };
              }
            }
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        await repo.logAction({
          order_id: input.order_id,
          tool_name: "issue_refund",
          input_json: JSON.stringify(input),
          result_json: JSON.stringify(result),
          success: !("error" in result),
        });

        if (!isReplay) {
          await repo.storeIdempotencyResult("issue_refund", input.idempotency_key, result);
        }

        return result;
      },
    },
  ];
}

export type ToolDefinition = ReturnType<typeof buildToolDefinitions>[number];
