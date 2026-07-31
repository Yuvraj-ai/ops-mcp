import fs from "fs";
import path from "path";
import { Pool } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL || "";

export function createPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL });
}

export async function initDatabase(pool: Pool): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}