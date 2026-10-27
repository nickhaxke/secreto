import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { localDatabase } from "../scripts/local-database.js";
import { createApp, draw } from "../netlify/functions/lib/app.js";
import {
  passwordHash,
  passwordMatches,
  hash,
  opaque,
} from "../netlify/functions/lib/security.js";
let db, owner, app, env, admin;
const origin = "https://secreto.example";
const eventData = {
  name: "Holiday circle",
  exchange_date: "2030-12-25",
  budget: 3500,
  currency: "USD",
};
async function request(
  path,
  body,
  cookie,
  method = body === undefined ? "GET" : "POST",
  ip = "test-client",
  headers = {},
) {
  const response = await app(
    new Request(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ip },
  );
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    headers: response.headers,
  };
}
async function create(names = "Alex\nJamie\nSam") {
  const e = await request("/events", eventData, admin);
  assert.equal(e.status, 201);
  const participants = await request(
    `/events/${e.body.id}/participants`,
    { names },
    admin,
  );
  assert.equal(participants.status, 201);
  return { id: e.body.id, invitations: participants.body.invitations };
}
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    assert(
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname.endsWith("_test"),
      "Tests require an isolated local *_test database",
    );
    owner = new pg.Pool({ connectionString: url.toString() });
    await owner.query("DROP SCHEMA IF EXISTS secreto_v2 CASCADE");
    await owner.query(
      await readFile("supabase/migrations/202610270001_secreto_v2.sql", "utf8"),
    );
    db = new pg.Pool({
      connectionString: url.toString(),
      options: "-c role=secreto_app",
      max: 10,
    });
  } else db = await localDatabase();
  env = {
    SECRETO_ORIGIN: origin,
    SECRETO_ADMIN_PASSWORD_HASH: await passwordHash("test-password-long"),
    SECRETO_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    SECRETO_CREDENTIALS_ROTATED: "true",
  };
  app = createApp({ db, env });
});
beforeEach(async () => {
  await (owner || db).query(
    "TRUNCATE secreto_v2.events,secreto_v2.participants,secreto_v2.sessions,secreto_v2.attempts CASCADE",
  );
  const login = await request("/login", { password: "test-password-long" });
  assert.equal(login.status, 200);
  admin = login.cookie;
});
after(async () => {
  await db?.end();
  await owner?.end();
});
test("event validation rejects missing names, impossible dates, past dates, bad currencies and budgets", async () => {
  for (const change of [
    { name: "" },
    { exchange_date: "2030-02-30" },
    { exchange_date: "2020-01-01" },
    { currency: "XXX" },
    { budget: -1 },
    { budget: 1.5 },
  ])
    assert.equal(
      (await request("/events", { ...eventData, ...change }, admin)).status,
      400,
    );
  const e = await request("/events", eventData, admin);
  assert.equal(e.status, 201);
  assert.equal(e.body.name, eventData.name);
});
test("bulk import accepts lines, commas, semicolons and prevents normalized duplicates atomically", async () => {
  const { id } = await create("Alex,Jamie;Sam");
  assert.equal(
    (
      await request(
        `/events/${id}/participants`,
        { names: "New Person\n alex " },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/events/${id}/participants`,
        { names: ["Chris", "CHRIS"] },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request(`/events/${id}`, undefined, admin)).body.participants.length,
    3,
  );
});
test("scrypt hashes are salted and validate without plaintext storage", async () => {
  const first = await passwordHash("123456"),
    second = await passwordHash("123456");
  assert.notEqual(first, second);
  assert(await passwordMatches("123456", first));
  assert.equal(await passwordMatches("123455", first), false);
  const {
    invitations: [invite],
  } = await create();
  const p = (
    await db.query(
      "SELECT token_hash,pin_hash FROM secreto_v2.participants WHERE id=$1",
      [invite.id],
    )
  ).rows[0];
  assert.equal(p.token_hash, hash(invite.token));
  assert(!p.pin_hash.includes(invite.pin));
  assert(await passwordMatches(invite.pin, p.pin_hash));
});
test("draw property: no self assignment and exactly one recipient at sizes 2 through 100", () => {
  for (let n = 2; n <= 100; n++)
    for (let iteration = 0; iteration < 10; iteration++) {
      const ids = Array.from({ length: n }, (_, i) => String(i));
      const result = draw(ids);
      assert.equal(new Set(result).size, n);
      assert(result.every((id, i) => id !== ids[i] && ids.includes(id)));
    }
  assert.throws(() => draw(["one"]));
  assert.throws(() => draw(["one", "one"]));
});
test("completed draws reject redraws, event edits, additions and removals", async () => {
  const { id, invitations } = await create();
  assert.equal((await request(`/events/${id}/draw`, {}, admin)).status, 200);
  for (const [path, body, method] of [
    [`/events/${id}/draw`, {}, "POST"],
    [`/events/${id}`, eventData, "PATCH"],
    [`/events/${id}/participants`, { names: "Pat" }, "POST"],
    [`/events/${id}/participants/${invitations[0].id}`, {}, "DELETE"],
  ])
    assert.equal((await request(path, body, admin, method)).status, 409);
});
test("concurrent draw requests produce exactly one committed assignment", async () => {
  const { id } = await create();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request(`/events/${id}/draw`, {}, admin)),
  );
  assert.deepEqual(
    responses.map((r) => r.status).sort(),
    [200, 409, 409, 409, 409],
  );
  const people = (
    await db.query(
      "SELECT id,recipient_id FROM secreto_v2.participants WHERE event_id=$1",
      [id],
    )
  ).rows;
  assert.equal(new Set(people.map((p) => p.recipient_id)).size, 3);
  assert(people.every((p) => p.id !== p.recipient_id));
});
test("concurrent duplicate imports commit only one list", async () => {
  const { id } = await create();
  const results = await Promise.all([
    request(`/events/${id}/participants`, { names: "Pat" }, admin),
    request(`/events/${id}/participants`, { names: "PAT" }, admin),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});
test("private endpoints reject missing authorization and unknown tokens", async () => {
  assert.equal((await request("/events")).status, 401);
  assert.equal(
    (await request("/invite/open", { token: opaque() })).status,
    401,
  );
  const {
    invitations: [invite],
  } = await create();
  assert.equal(
    (await request("/invite/reveal", { token: invite.token })).status,
    401,
  );
  assert.equal(
    (await request("/invite/reveal", { token: invite.token }, admin)).status,
    401,
  );
});
test("wrong PIN and account-based rate limit persist across IP changes", async () => {
  const {
    invitations: [invite],
  } = await create();
  const wrong = invite.pin === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await request(
          "/invite/verify",
          { token: invite.token, pin: wrong },
          null,
          "POST",
          `attacker-${i}`,
        )
      ).status,
      401,
    );
  const limited = await request(
    "/invite/verify",
    { token: invite.token, pin: invite.pin },
    null,
    "POST",
    "new-ip",
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
});
test("valid PIN reveals one stable recipient and cannot reveal a different participant", async () => {
  const { id, invitations } = await create();
  await request(`/events/${id}/draw`, {}, admin);
  const [invite, other] = invitations;
  const auth = await request("/invite/verify", {
    token: invite.token,
    pin: invite.pin,
  });
  assert.equal(auth.status, 200);
  const first = await request(
    "/invite/reveal",
    { token: invite.token },
    auth.cookie,
  );
  assert.equal(first.status, 200);
  assert.notEqual(first.body.recipient, invite.name);
  assert.deepEqual(Object.keys(first.body), ["recipient"]);
  assert.deepEqual(
    (await request("/invite/reveal", { token: invite.token }, auth.cookie))
      .body,
    first.body,
  );
  assert.equal(
    (await request("/invite/reveal", { token: other.token }, auth.cookie))
      .status,
    403,
  );
  assert.equal((await request("/events", undefined, auth.cookie)).status, 401);
});
test("progress tracks opened and revealed idempotently; dashboard never includes pairings", async () => {
  const {
    id,
    invitations: [invite],
  } = await create();
  await request(`/events/${id}/draw`, {}, admin);
  for (let i = 0; i < 2; i++)
    await request("/invite/open", { token: invite.token });
  const auth = await request("/invite/verify", {
    token: invite.token,
    pin: invite.pin,
  });
  await request("/invite/reveal", { token: invite.token }, auth.cookie);
  const result = await request(`/events/${id}`, undefined, admin);
  assert.equal(result.body.event.total, 3);
  assert.equal(result.body.event.opened, 1);
  assert.equal(result.body.event.revealed, 1);
  assert.equal(result.body.event.pending, 2);
  assert.equal(result.body.event.completion, 33);
  assert(!/recipient|token_hash|pin_hash/.test(JSON.stringify(result.body)));
  const listing = await request("/events", undefined, admin);
  assert.equal(listing.body.events[0].revealed, 1);
});
test("replacement invitation revokes old tokens and sessions without changing pairing", async () => {
  const {
    id,
    invitations: [invite],
  } = await create();
  await request(`/events/${id}/draw`, {}, admin);
  const auth = await request("/invite/verify", {
    token: invite.token,
    pin: invite.pin,
  });
  const original = await request(
    "/invite/reveal",
    { token: invite.token },
    auth.cookie,
  );
  const replacement = (
    await request(`/events/${id}/participants/${invite.id}/invite`, {}, admin)
  ).body.invitation;
  assert.equal(
    (await request("/invite/open", { token: invite.token })).status,
    401,
  );
  assert.equal(
    (await request("/invite/reveal", { token: replacement.token }, auth.cookie))
      .status,
    401,
  );
  const newAuth = await request("/invite/verify", {
    token: replacement.token,
    pin: replacement.pin,
  });
  assert.deepEqual(
    (
      await request(
        "/invite/reveal",
        { token: replacement.token },
        newAuth.cookie,
      )
    ).body,
    original.body,
  );
});
test("admin password, cookies, logout, expiry, origin and content type are enforced", async () => {
  assert.equal((await request("/login", { password: "wrong" })).status, 401);
  const auth = await request("/login", { password: "test-password-long" });
  const cookie = auth.headers.get("set-cookie");
  for (const value of [
    "__Host-secreto_session=",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ])
    assert(cookie.includes(value));
  assert.equal(
    (
      await request("/events", eventData, admin, "POST", "test-client", {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/events", eventData, admin, "POST", "test-client", {
        "Content-Type": "text/plain",
      })
    ).status,
    403,
  );
  await request("/logout", {}, auth.cookie);
  assert.equal((await request("/events", undefined, auth.cookie)).status, 401);
  await db.query(
    "UPDATE secreto_v2.sessions SET expires_at=now()-interval '1 second'",
  );
  assert.equal((await request("/events", undefined, admin)).status, 401);
});
test("server fails closed until credential rotation is confirmed", async () => {
  const unavailable = createApp({
    db,
    env: { ...env, SECRETO_CREDENTIALS_ROTATED: "false" },
  });
  assert.equal(
    (await unavailable(new Request(origin + "/api/session"))).status,
    503,
  );
});
test("database rejects self assignment and cross-event pairing", async () => {
  const a = await create(),
    b = await create();
  await assert.rejects(
    db.query("UPDATE secreto_v2.participants SET recipient_id=id WHERE id=$1", [
      a.invitations[0].id,
    ]),
    { code: "23514" },
  );
  await assert.rejects(
    db.query("UPDATE secreto_v2.participants SET recipient_id=$2 WHERE id=$1", [
      a.invitations[0].id,
      b.invitations[0].id,
    ]),
    { code: "23503" },
  );
});
test("RLS enabled on every private table and PUBLIC has no schema access", async () => {
  const tables = (
    await db.query(
      "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='secreto_v2' AND c.relkind='r'",
    )
  ).rows;
  assert.equal(tables.length, 4);
  assert(tables.every((t) => t.relrowsecurity));
  const schema = (
    await db.query(
      "SELECT nspacl::text FROM pg_namespace WHERE nspname='secreto_v2'",
    )
  ).rows[0];
  assert(!schema.nspacl.includes(",=") && !schema.nspacl.startsWith("{="));
});

test("an unprivileged database role cannot read participants or sessions", async () => {
  const privileged = owner || db;
  await privileged.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='secreto_test_anon') THEN CREATE ROLE secreto_test_anon NOLOGIN; END IF; END $$",
  );
  const client = await privileged.connect();
  try {
    for (const table of ["participants", "sessions"]) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE secreto_test_anon");
      await assert.rejects(client.query(`SELECT * FROM secreto_v2.${table}`), {
        code: "42501",
      });
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
});

test("participant can authenticate before draw but cannot reveal until the draw", async () => {
  const {
    id,
    invitations: [invite],
  } = await create();
  const auth = await request("/invite/verify", {
    token: invite.token,
    pin: invite.pin,
  });
  assert.equal(
    (await request("/invite/reveal", { token: invite.token }, auth.cookie))
      .status,
    409,
  );
  await request(`/events/${id}/draw`, {}, admin);
  assert.equal(
    (await request("/invite/reveal", { token: invite.token }, auth.cookie))
      .status,
    200,
  );
});

test("input boundaries reject numeric PINs, markup, empty imports and oversized bodies", async () => {
  const {
    id,
    invitations: [invite],
  } = await create();
  assert.equal(
    (
      await request("/invite/verify", {
        token: invite.token,
        pin: Number(invite.pin),
      })
    ).status,
    401,
  );
  for (const names of [
    "",
    ["<script>"],
    ["A".repeat(81)],
    Array.from({ length: 101 }, (_, i) => `Person ${i}`),
  ]) {
    assert.equal(
      (await request(`/events/${id}/participants`, { names }, admin)).status,
      400,
    );
  }
  assert.equal(
    (await request("/events", { ...eventData, name: "A".repeat(21000) }, admin))
      .status,
    413,
  );
  const malformed = await app(
    new Request(origin + "/api/events", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: admin,
      },
      body: "{broken",
    }),
  );
  assert.equal(malformed.status, 400);
});
