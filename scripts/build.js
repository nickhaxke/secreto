import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
for (const path of [
  "public/index.html",
  "public/style.css",
  "public/app.js",
  "netlify/functions/api.js",
])
  assert((await stat(path)).size > 0, `${path} is missing`);
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith(".js"))
      execFileSync(process.execPath, ["--check", path]);
  }
}
await check("netlify/functions");
await check("public");
for (const name of await readdir("public")) {
  const content = await readFile(`public/${name}`, "utf8");
  assert(
    !/postgres(?:ql)?:\/\/|sb_secret_|service_role|SUPABASE_SECRET_KEY|SECRETO_ADMIN_PASSWORD_HASH/.test(
      content,
    ),
    `Sensitive server reference in ${name}`,
  );
}
console.log(
  "Production static files and server functions validated. No bundling required.",
);
