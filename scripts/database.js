import { readFile } from "node:fs/promises";
import { database } from "../netlify/functions/lib/database.js";
const operation = process.argv[2];
if (!["inspect", "migrate"].includes(operation))
  throw new Error("Use inspect or migrate.");
if (operation === "migrate" && process.env.SECRETO_SCHEMA_REVIEWED !== "true")
  throw new Error(
    "Inspect the existing schema first; set SECRETO_SCHEMA_REVIEWED=true only after compatibility review.",
  );
const db = database();
try {
  const file =
    operation === "inspect"
      ? "scripts/inspect.sql"
      : "supabase/migrations/202610270001_secreto_v2.sql";
  const results = await db.query(await readFile(file, "utf8"));
  if (operation === "inspect")
    for (const result of Array.isArray(results) ? results : [results])
      console.log(JSON.stringify(result.rows, null, 2));
  else
    console.log(
      "Secreto V2 migration applied. Existing legacy tables were not changed.",
    );
} catch {
  console.error(
    "Database operation failed. Verify secure connectivity, privileges, and schema compatibility.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
