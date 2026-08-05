import { Pool } from "pg";
import "dotenv/config";
import { initDatabase } from "../db/schema.js";
import { seedDatabase } from "../db/seed.js";

/**
 * Test-database harness.
 *
 * Tests run against a REAL Postgres instance, in a dedicated schema, because the
 * properties under test — transactional rollback and concurrent row locking —
 * are exactly the ones an in-memory emulation gets wrong. `pg-mem` was found to
 * accept BEGIN/ROLLBACK without actually rolling back, which meant every abort
 * assertion in the old suite was passing without verifying anything.
 *
 * Isolation strategy: a dedicated schema (not the `public` schema the demo data
 * lives in), selected via the connection's `search_path`. The demo orders the
 * client records against are therefore untouched by test runs, even when a
 * concurrency test leaves rows half-mutated.
 */

export const TEST_SCHEMA = process.env.TEST_SCHEMA || "ops_mcp_test";

function baseUrl(): string {
  // Prefer an explicit TEST_DATABASE_URL. Fall back to DATABASE_URL, which is
  // safe here only because we pin search_path to a dedicated schema below.
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!url) {
    throw new Error(
      "No TEST_DATABASE_URL or DATABASE_URL set — tests require a real Postgres instance."
    );
  }
  return url;
}

function needsSsl(url: string): boolean {
  return url.includes("supabase.co") || url.includes("pooler.supabase.com");
}

/** A pool whose connections all resolve unqualified table names to TEST_SCHEMA. */
export function createTestPool(): Pool {
  const url = baseUrl();
  const sep = url.includes("?") ? "&" : "?";
  const scoped = `${url}${sep}options=${encodeURIComponent(`-c search_path=${TEST_SCHEMA}`)}`;
  const config: ConstructorParameters<typeof Pool>[0] = { connectionString: scoped };
  if (needsSsl(url)) config.ssl = { rejectUnauthorized: false };
  return new Pool(config);
}

/**
 * Drop and recreate the test schema, then create tables and seed demo rows.
 * Called before each suite run so tests start from a known state.
 */
export async function resetTestSchema(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await initDatabase(pool);
  await seedDatabase(pool);
}

/** Remove the test schema entirely. */
export async function dropTestSchema(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
}
