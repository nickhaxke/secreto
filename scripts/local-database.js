import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
export async function localDatabase() {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610270001_secreto_v2.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let tail = Promise.resolve();
  async function connect() {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return { query: (sql, args) => pg.query(sql, args), release };
  }
  return {
    connect,
    async query(sql, args) {
      const client = await connect();
      try {
        return await client.query(sql, args);
      } finally {
        client.release();
      }
    },
    end: () => pg.close(),
  };
}
