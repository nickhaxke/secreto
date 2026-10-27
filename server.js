import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createApp } from "./netlify/functions/lib/app.js";
import { database } from "./netlify/functions/lib/database.js";
import { passwordHash } from "./netlify/functions/lib/security.js";
const port = Number(process.env.PORT || 3000);
const demo = process.env.SECRETO_DEMO === "1";
if (demo && process.env.NETLIFY)
  throw new Error("Local demo mode cannot run on Netlify.");
const env = { ...process.env };
let db;
if (demo) {
  const { localDatabase } = await import("./scripts/local-database.js");
  db = await localDatabase();
  env.SECRETO_ORIGIN = `http://localhost:${port}`;
  env.SECRETO_ADMIN_PASSWORD_HASH = await passwordHash("secreto-local-only");
  env.SECRETO_SESSION_SECRET =
    "local-development-only-secret-not-for-production";
} else db = database(env);
const app = createApp({ db, env, development: demo });
const root = resolve("public");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};
export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 20000) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      const response = await app(request, { ip: req.socket.remoteAddress });
      res.writeHead(response.status, {
        ...securityHeaders,
        ...Object.fromEntries(response.headers),
      });
      res.end(await response.text());
      return;
    }
    const pathname =
      url.pathname === "/" || url.pathname.startsWith("/invite/")
        ? "/index.html"
        : decodeURIComponent(url.pathname);
    const file = resolve(root, "." + pathname);
    if (!file.startsWith(root + "/") || !types[extname(file)]) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const content = await readFile(file);
    res.writeHead(200, {
      ...securityHeaders,
      "Content-Type": types[extname(file)],
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Secreto listening on port ${port}${demo ? " (isolated local demo; password: secreto-local-only)" : ""}`,
  ),
);
async function stop() {
  server.close();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
