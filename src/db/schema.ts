import fs from "fs";
import path from "path";
import { Pool } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL || "";

export function createPool(): Pool {
  const config: ConstructorParameters<typeof Pool>[0] = { connectionString: DATABASE_URL };
  if (DATABASE_URL.includes("supabase.co") || DATABASE_URL.includes("pooler.supabase.com")) {
    config.ssl = { rejectUnauthorized: false };
  }
  return new Pool(config);
}

export async function initDatabase(pool: Pool): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}