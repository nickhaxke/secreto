import pg from "pg";
let pool;
export function database(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!pool) {
    const url = new URL(env.DATABASE_URL);
    // Connection-string SSL options must not override certificate verification.
    for (const key of [
      "ssl",
      "sslmode",
      "sslcert",
      "sslkey",
      "sslrootcert",
      "uselibpqcompat",
    ])
      url.searchParams.delete(key);
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 3,
      connectionTimeoutMillis: 10000,
      ssl: {
        rejectUnauthorized: true,
        ...(env.DATABASE_CA_CERT
          ? { ca: env.DATABASE_CA_CERT.replace(/\\n/g, "\n") }
          : {}),
      },
    });
  }
  return pool;
}
export async function transaction(db, work) {
  const client = await db.connect();
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
