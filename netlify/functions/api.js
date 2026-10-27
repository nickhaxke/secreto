import { database } from "./lib/database.js";
import { createApp } from "./lib/app.js";
let app;
export default async (request, context) => {
  try {
    app ||= createApp({ db: database(), env: process.env });
    return await app(request, { ip: context.ip });
  } catch {
    return Response.json(
      { error: "Secreto is awaiting secure server configuration." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
export const config = { path: "/api/*" };
