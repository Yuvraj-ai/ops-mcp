import fs from "fs";
import path from "path";
import { Pool } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL || "";

export function createPool(): Pool {
  const config: ConstructorParameters<typeof Pool>[0] = {
    connectionString: DATABASE_URL,

    // Every one of these has an unbounded default. Left unset, a database that
    // is merely slow or briefly unreachable does not produce an error — it
    // produces an HTTP request that never completes, because there is no
    // timeout at any layer to end the wait. Bounded waits turn that silent
    // hang into a fast, loggable failure the caller can retry.
    //
    //   connectionTimeoutMillis: pg default 0 = wait forever for a free slot
    //   statement_timeout:       pg default off = a query can run forever
    //   query_timeout:           pg default off = client-side counterpart
    //
    // 15s is far above the ~1s these queries actually take, so it only fires
    // on a genuine fault. It also bounds the pg_advisory_xact_lock wait in the
    // write path, which is a blocking statement by design — bounding it is
    // deliberate, so a stuck lock holder cannot pin a request indefinitely.
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    keepAlive: true,
  };
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