import pg from "pg";
import { config } from "../config.js";

// A single shared connection pool for the whole app. Managed Postgres (Supabase,
// RDS, etc.) requires SSL; rejectUnauthorized:false accepts their managed certs.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
});

// Thin query helper so call sites stay tidy.
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

// Run a set of statements inside a single transaction. The callback gets a
// dedicated client; if it throws, everything rolls back.
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
