import pg, { type Pool, type PoolClient } from "pg";
export interface Db {
  pool: Pool;
  close(): Promise<void>;
}
export function openDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on("error", () => {
    process.stderr.write(
      JSON.stringify({ component: "database", code: "idle_connection_lost" }) +
        "\n",
    );
  });
  return { pool, close: () => pool.end() };
}
export async function transaction<T>(
  db: Db,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
