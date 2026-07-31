import "dotenv/config";
import { Pool } from "pg";
import { initDatabase } from "./schema.js";

export async function seedDatabase(pool: Pool): Promise<void> {
  const now = Date.now();
  const iso = (offsetMinutes: number) =>
    new Date(now + offsetMinutes * 60_000).toISOString();

  const stockRows = [
    ["SKU-101", 0],
    ["SKU-202", 12],
    ["SKU-303", 25],
    ["SKU-404", 8],
    ["SKU-505", 3],
  ] as const;

  for (const [sku, qty] of stockRows) {
    await pool.query(
      `INSERT INTO inventory_stock (sku, available_qty) VALUES ($1, $2)
       ON CONFLICT (sku) DO NOTHING`,
      [sku, qty],
    );
  }

  const orders = [
    {
      id: "A1001",
      customer_name: "Riya Sharma",
      status: "delivered",
      total_amount: 1499,
      sku: "SKU-303",
      created_at: iso(-10000),
      payment: { id: "P1001", order_id: "A1001", status: "captured", amount: 1499, captured_at: iso(-9990) },
      hold: { id: "H1001", order_id: "A1001", sku: "SKU-303", quantity: 1, status: "released", expires_at: iso(-9000) },
      shipment: { id: "S1001", order_id: "A1001", status: "delivered", carrier: "BlueDart", updated_at: iso(-500) },
    },
    {
      id: "A1002",
      customer_name: "Karan Mehta",
      status: "shipped",
      total_amount: 2199,
      sku: "SKU-303",
      created_at: iso(-4000),
      payment: { id: "P1002", order_id: "A1002", status: "captured", amount: 2199, captured_at: iso(-3990) },
      hold: { id: "H1002", order_id: "A1002", sku: "SKU-303", quantity: 1, status: "released", expires_at: iso(-3000) },
      shipment: { id: "S1002", order_id: "A1002", status: "shipped", carrier: "Delhivery", updated_at: iso(-100) },
    },
    {
      id: "A1003",
      customer_name: "Ayesha Khan",
      status: "processing",
      total_amount: 899,
      sku: "SKU-404",
      created_at: iso(-800),
      payment: { id: "P1003", order_id: "A1003", status: "captured", amount: 899, captured_at: iso(-790) },
      hold: { id: "H1003", order_id: "A1003", sku: "SKU-404", quantity: 1, status: "released", expires_at: iso(-700) },
      shipment: { id: "S1003", order_id: "A1003", status: "processing", carrier: "Delhivery", updated_at: iso(-50) },
    },
    {
      id: "A1004",
      customer_name: "Vikram Rao",
      status: "confirmed",
      total_amount: 3499,
      sku: "SKU-404",
      created_at: iso(-200),
      payment: { id: "P1004", order_id: "A1004", status: "captured", amount: 3499, captured_at: iso(-190) },
      hold: { id: "H1004", order_id: "A1004", sku: "SKU-404", quantity: 1, status: "active", expires_at: iso(60) },
      shipment: { id: "S1004", order_id: "A1004", status: "pending", carrier: null, updated_at: iso(-190) },
    },
    {
      id: "A1005",
      customer_name: "Neha Joshi",
      status: "placed",
      total_amount: 599,
      sku: "SKU-505",
      created_at: iso(-30),
      payment: { id: "P1005", order_id: "A1005", status: "authorized", amount: 599, captured_at: null },
      hold: { id: "H1005", order_id: "A1005", sku: "SKU-505", quantity: 1, status: "active", expires_at: iso(30) },
      shipment: { id: "S1005", order_id: "A1005", status: "pending", carrier: null, updated_at: iso(-30) },
    },
    {
      id: "A1023",
      customer_name: "Rohan Gupta",
      status: "failed",
      total_amount: 2499,
      sku: "SKU-202",
      created_at: iso(-120),
      payment: { id: "P1023", order_id: "A1023", status: "captured", amount: 2499, captured_at: iso(-119) },
      hold: { id: "H1023", order_id: "A1023", sku: "SKU-202", quantity: 1, status: "expired", expires_at: iso(-60) },
    },
    {
      id: "A1024",
      customer_name: "Sneha Patil",
      status: "failed",
      total_amount: 1799,
      sku: "SKU-101",
      created_at: iso(-150),
      payment: { id: "P1024", order_id: "A1024", status: "captured", amount: 1799, captured_at: iso(-149) },
      hold: { id: "H1024", order_id: "A1024", sku: "SKU-101", quantity: 1, status: "expired", expires_at: iso(-90) },
    },
    {
      id: "A1025",
      customer_name: "Arjun Nair",
      status: "refunded",
      total_amount: 999,
      sku: "SKU-303",
      created_at: iso(-5000),
      payment: { id: "P1025", order_id: "A1025", status: "refunded", amount: 999, captured_at: iso(-4990) },
      hold: { id: "H1025", order_id: "A1025", sku: "SKU-303", quantity: 1, status: "released", expires_at: iso(-4900) },
    },
    {
      id: "A1026",
      customer_name: "Meera Iyer",
      status: "cancelled",
      total_amount: 1299,
      sku: "SKU-404",
      created_at: iso(-2000),
      payment: { id: "P1026", order_id: "A1026", status: "authorized", amount: 1299, captured_at: null },
      hold: { id: "H1026", order_id: "A1026", sku: "SKU-404", quantity: 1, status: "released", expires_at: iso(-1900) },
    },
    {
      id: "A1027",
      customer_name: "Farhan Ali",
      status: "confirmed",
      total_amount: 1599,
      sku: "SKU-202",
      created_at: iso(-15),
      payment: { id: "P1027", order_id: "A1027", status: "captured", amount: 1599, captured_at: iso(-14) },
      hold: { id: "H1027", order_id: "A1027", sku: "SKU-202", quantity: 1, status: "active", expires_at: iso(45) },
      shipment: { id: "S1027", order_id: "A1027", status: "pending", carrier: null, updated_at: iso(-14) },
    },
  ];

  for (const order of orders) {
    await pool.query(
      `INSERT INTO orders (id, customer_name, status, total_amount, sku, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.id,
        order.customer_name,
        order.status,
        order.total_amount,
        order.sku,
        order.created_at,
      ],
    );

    await pool.query(
      `INSERT INTO payments (id, order_id, status, amount, captured_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.payment.id,
        order.payment.order_id,
        order.payment.status,
        order.payment.amount,
        order.payment.captured_at,
      ],
    );

    await pool.query(
      `INSERT INTO inventory_holds (id, order_id, sku, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.hold.id,
        order.hold.order_id,
        order.hold.sku,
        order.hold.quantity,
        order.hold.status,
        order.hold.expires_at,
      ],
    );

    if (order.shipment) {
      await pool.query(
        `INSERT INTO shipments (id, order_id, status, carrier, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          order.shipment.id,
          order.shipment.order_id,
          order.shipment.status,
          order.shipment.carrier,
          order.shipment.updated_at,
        ],
      );
    }
  }
}

if (__filename === process.argv[1]) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
   const config: ConstructorParameters<typeof Pool>[0] = { connectionString: databaseUrl };
   if (databaseUrl.includes("supabase.co") || databaseUrl.includes("pooler.supabase.com")) {
     config.ssl = { rejectUnauthorized: false };
   }
   const pool = new Pool(config);
  initDatabase(pool)
    .then(() => seedDatabase(pool))
    .then(() => {
      console.log("Database seeded successfully.");
      pool.end();
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      pool.end().finally(() => process.exit(1));
    });
}
