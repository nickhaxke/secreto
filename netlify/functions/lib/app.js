import { randomInt, randomUUID } from "node:crypto";
import { Random, nodeCrypto } from "random-js";
import { transaction } from "./database.js";
import {
  hash,
  opaque,
  fingerprint,
  passwordHash,
  passwordMatches,
  fail,
  participantNames,
  normalized,
  eventInput,
} from "./security.js";

const random = new Random(nodeCrypto);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function draw(ids) {
  if (ids.length < 2 || new Set(ids).size !== ids.length)
    fail(400, "At least two distinct participants are required.");
  // Rejection sampling over cryptographically shuffled permutations is uniform.
  let recipients;
  do {
    recipients = random.shuffle([...ids]);
  } while (recipients.some((id, i) => id === ids[i]));
  return recipients;
}
export function createApp({ db, env, development = false }) {
  const origin = env.SECRETO_ORIGIN;
  const cookieName = development ? "secreto_session" : "__Host-secreto_session";
  const cookie = (token, age = 28800) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${development ? "" : "; Secure"}`;
  const rows = async (sql, values = [], client = db) =>
    (await client.query(sql, values)).rows;
  let adminHashPromise;
  const adminHash = () => {
    if (!adminHashPromise) {
      adminHashPromise = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(
        env.SECRETO_ADMIN_PASSWORD_HASH || "",
      )
        ? Promise.resolve(env.SECRETO_ADMIN_PASSWORD_HASH)
        : typeof env.SECRETO_ADMIN_PASSWORD === "string" &&
            env.SECRETO_ADMIN_PASSWORD.length >= 14 &&
            env.SECRETO_ADMIN_PASSWORD.length <= 256
          ? passwordHash(env.SECRETO_ADMIN_PASSWORD)
          : Promise.resolve(null);
    }
    return adminHashPromise;
  };
  async function limit(key, max, seconds = 900) {
    const [{ count }] = await rows(
      `INSERT INTO secreto_v2.attempts(key,count,reset_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN attempts.reset_at < now() THEN 1 ELSE attempts.count+1 END,
      reset_at=CASE WHEN attempts.reset_at < now() THEN now()+$2*interval '1 second' ELSE attempts.reset_at END RETURNING count`,
      [key, seconds],
    );
    if (count > max)
      fail(429, "Too many attempts. Please try again in 15 minutes.");
  }
  async function session(request) {
    const value = (request.headers.get("cookie") || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!tokenPattern.test(value || "")) return null;
    const [record] = await rows(
      "SELECT role,participant_id,token_hash FROM secreto_v2.sessions WHERE token_hash=$1 AND expires_at>now()",
      [hash(value)],
    );
    return record;
  }
  async function newSession(role, id, client, old) {
    if (old)
      await client.query(
        "DELETE FROM secreto_v2.sessions WHERE token_hash=$1",
        [old.token_hash],
      );
    const value = opaque();
    await client.query(
      "INSERT INTO secreto_v2.sessions VALUES($1,$2,$3,now()+interval '8 hours')",
      [hash(value), role, id],
    );
    return value;
  }
  async function event(id, client, unlocked = false) {
    if (!uuid.test(id)) fail(404, "Event not found.");
    const [record] = await rows(
      "SELECT * FROM secreto_v2.events WHERE id=$1 FOR UPDATE",
      [id],
      client,
    );
    if (!record) fail(404, "Event not found.");
    if (unlocked && record.drawn_at)
      fail(
        409,
        "This draw is complete. The guest list and event details are locked.",
      );
    return record;
  }
  async function credentials() {
    const token = opaque();
    const pin = String(randomInt(1000000)).padStart(6, "0");
    return {
      token,
      pin,
      tokenHash: hash(token),
      pinHash: await passwordHash(pin),
    };
  }
  const invitation = (id, name, c) => ({
    id,
    name,
    token: c.token,
    pin: c.pin,
    url: `${origin}/invite/#${c.token}`,
  });
  const statistics = `SELECT e.id,e.name,e.exchange_date,e.budget,e.currency,e.drawn_at,e.created_at,
    count(p.id)::int AS total, count(p.opened_at)::int AS opened, count(p.revealed_at)::int AS revealed,
    (count(p.id)-count(p.opened_at))::int AS pending,
    CASE WHEN count(p.id)=0 THEN 0 ELSE round(100.0*count(p.revealed_at)/count(p.id))::int END AS completion
    FROM secreto_v2.events e LEFT JOIN secreto_v2.participants p ON p.event_id=e.id`;
  return async function handle(request, { ip = "unknown" } = {}) {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    const respond = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    try {
      if (
        !origin ||
        !env.SECRETO_SESSION_SECRET ||
        env.SECRETO_SESSION_SECRET.length < 32 ||
        !(await adminHash()) ||
        (!development &&
          (env.SECRETO_CREDENTIALS_ROTATED !== "true" ||
            !origin.startsWith("https://")))
      )
        fail(503, "Secreto is awaiting secure server configuration.");
      const method = request.method;
      const path =
        new URL(request.url).pathname
          .replace(/^\/\.netlify\/functions\/api/, "")
          .replace(/^\/api/, "")
          .replace(/\/$/, "") || "/";
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method))
        fail(405, "Method not allowed.");
      if (
        method !== "GET" &&
        (request.headers.get("origin") !== origin ||
          !request.headers.get("content-type")?.startsWith("application/json"))
      )
        fail(403, "Please submit this request from Secreto.");
      let body = {};
      if (method !== "GET") {
        const raw = await request.text();
        if (raw.length > 20000) fail(413, "This request is too large.");
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          fail(400, "Invalid request.");
        }
        if (!body || Array.isArray(body) || typeof body !== "object")
          fail(400, "Invalid request.");
      }
      const identity = fingerprint(ip, env.SECRETO_SESSION_SECRET);
      await limit(`request:${identity}`, 240, 60);
      if (randomInt(100) === 0) {
        await db.query(
          "DELETE FROM secreto_v2.sessions WHERE expires_at<now()",
        );
        await db.query("DELETE FROM secreto_v2.attempts WHERE reset_at<now()");
      }
      const auth = await session(request);
      if (path === "/session" && method === "GET")
        return respond({ role: auth?.role || null });
      if (path === "/logout" && method === "POST") {
        if (auth)
          await db.query(
            "DELETE FROM secreto_v2.sessions WHERE token_hash=$1",
            [auth.token_hash],
          );
        headers["Set-Cookie"] = cookie("", 0);
        return respond({ ok: true });
      }
      if (path === "/login" && method === "POST") {
        await limit(`admin:${identity}`, 10);
        await limit("admin:global", 100);
        if (
          typeof body.password !== "string" ||
          body.password.length > 256 ||
          !(await passwordMatches(body.password, await adminHash()))
        )
          fail(401, "The password is incorrect.");
        const token = await transaction(db, (client) =>
          newSession("admin", null, client, auth),
        );
        headers["Set-Cookie"] = cookie(token);
        return respond({ role: "admin" });
      }
      if (path.startsWith("/invite") && method === "POST") {
        if (typeof body.token !== "string" || !tokenPattern.test(body.token))
          fail(401, "Invitation or PIN is incorrect.");
        await limit(`invite-ip:${identity}`, 30);
        const tokenHash = hash(body.token);
        if (path === "/invite/open") {
          const result = await transaction(db, async (client) => {
            const [p] = await rows(
              "UPDATE secreto_v2.participants SET opened_at=coalesce(opened_at,now()) WHERE token_hash=$1 RETURNING id,event_id",
              [tokenHash],
              client,
            );
            if (!p) fail(401, "Invitation or PIN is incorrect.");
            const [e] = await rows(
              "SELECT name,exchange_date,budget,currency,drawn_at FROM secreto_v2.events WHERE id=$1",
              [p.event_id],
              client,
            );
            return {
              event: e,
              authorized:
                auth?.role === "participant" && auth.participant_id === p.id,
            };
          });
          return respond(result);
        }
        if (path === "/invite/verify") {
          await limit(`pin:${tokenHash}`, 5);
          if (typeof body.pin !== "string" || !/^\d{6}$/.test(body.pin))
            fail(401, "Invitation or PIN is incorrect.");
          const token = await transaction(db, async (client) => {
            const [p] = await rows(
              "SELECT id,pin_hash FROM secreto_v2.participants WHERE token_hash=$1 FOR UPDATE",
              [tokenHash],
              client,
            );
            // Unknown tokens still perform the expensive hash comparison.
            const valid = await passwordMatches(
              body.pin,
              p?.pin_hash || (await adminHash()),
            );
            if (!p || !valid) fail(401, "Invitation or PIN is incorrect.");
            await client.query(
              "UPDATE secreto_v2.participants SET opened_at=coalesce(opened_at,now()) WHERE id=$1",
              [p.id],
            );
            return newSession("participant", p.id, client, auth);
          });
          headers["Set-Cookie"] = cookie(token);
          return respond({ ok: true });
        }
        if (path === "/invite/reveal") {
          if (auth?.role !== "participant")
            fail(401, "Enter your invitation PIN first.");
          const result = await transaction(db, async (client) => {
            const [p] = await rows(
              "SELECT id,event_id,recipient_id FROM secreto_v2.participants WHERE id=$1 AND token_hash=$2 FOR UPDATE",
              [auth.participant_id, tokenHash],
              client,
            );
            if (!p)
              fail(403, "This invitation belongs to another participant.");
            if (!p.recipient_id)
              fail(409, "Your organizer has not drawn names yet.");
            const [recipient] = await rows(
              "SELECT name FROM secreto_v2.participants WHERE id=$1",
              [p.recipient_id],
              client,
            );
            await client.query(
              "UPDATE secreto_v2.participants SET revealed_at=coalesce(revealed_at,now()) WHERE id=$1",
              [p.id],
            );
            return { recipient: recipient.name };
          });
          return respond(result);
        }
        fail(404, "Not found.");
      }
      if (auth?.role !== "admin") fail(401, "Please sign in as the organizer.");
      if (path === "/events" && method === "GET")
        return respond({
          events: await rows(
            statistics + " GROUP BY e.id ORDER BY e.created_at DESC",
          ),
        });
      if (path === "/events" && method === "POST") {
        const e = eventInput(body),
          id = randomUUID();
        await db.query(
          "INSERT INTO secreto_v2.events(id,name,exchange_date,budget,currency) VALUES($1,$2,$3,$4,$5)",
          [id, e.name, e.exchange_date, e.budget, e.currency],
        );
        return respond({ id, ...e }, 201);
      }
      const match = path.match(
        /^\/events\/([a-f0-9-]+)(?:\/(participants|draw)(?:\/([a-f0-9-]+)(?:\/(invite))?)?)?$/i,
      );
      if (!match || !uuid.test(match[1])) fail(404, "Not found.");
      const [, id, action, participantId, inviteAction] = match;
      if (participantId && !uuid.test(participantId)) fail(404, "Not found.");
      if (!action && method === "GET") {
        const [e] = await rows(statistics + " WHERE e.id=$1 GROUP BY e.id", [
          id,
        ]);
        if (!e) fail(404, "Event not found.");
        const participants = await rows(
          "SELECT id,name,CASE WHEN revealed_at IS NOT NULL THEN 'Revealed' WHEN opened_at IS NOT NULL THEN 'Opened' ELSE 'Pending' END AS status FROM secreto_v2.participants WHERE event_id=$1 ORDER BY normalized_name",
          [id],
        );
        return respond({ event: e, participants });
      }
      if (!action && method === "PATCH") {
        const e = eventInput(body);
        await transaction(db, async (client) => {
          await event(id, client, true);
          await client.query(
            "UPDATE secreto_v2.events SET name=$2,exchange_date=$3,budget=$4,currency=$5 WHERE id=$1",
            [id, e.name, e.exchange_date, e.budget, e.currency],
          );
        });
        return respond({ ok: true });
      }
      if (action === "participants" && !participantId && method === "POST") {
        const names = participantNames(body.names);
        const prepared = [];
        for (const name of names)
          prepared.push({ id: randomUUID(), name, c: await credentials() });
        const invitations = await transaction(db, async (client) => {
          await event(id, client, true);
          const existing = await rows(
            "SELECT normalized_name FROM secreto_v2.participants WHERE event_id=$1",
            [id],
            client,
          );
          if (existing.length + names.length > 100)
            fail(400, "An event can have up to 100 participants.");
          if (
            names.some((n) =>
              existing.some((p) => p.normalized_name === normalized(n)),
            )
          )
            fail(409, "Each participant needs a unique name.");
          for (const p of prepared)
            await client.query(
              "INSERT INTO secreto_v2.participants(id,event_id,name,normalized_name,token_hash,pin_hash) VALUES($1,$2,$3,$4,$5,$6)",
              [
                p.id,
                id,
                p.name,
                normalized(p.name),
                p.c.tokenHash,
                p.c.pinHash,
              ],
            );
          return prepared.map((p) => invitation(p.id, p.name, p.c));
        });
        return respond({ invitations }, 201);
      }
      if (
        action === "participants" &&
        participantId &&
        !inviteAction &&
        method === "DELETE"
      ) {
        await transaction(db, async (client) => {
          await event(id, client, true);
          await client.query(
            "DELETE FROM secreto_v2.participants WHERE event_id=$1 AND id=$2",
            [id, participantId],
          );
        });
        return respond({ ok: true });
      }
      if (
        action === "participants" &&
        participantId &&
        inviteAction &&
        method === "POST"
      ) {
        const c = await credentials();
        const result = await transaction(db, async (client) => {
          await event(id, client);
          const [p] = await rows(
            "UPDATE secreto_v2.participants SET token_hash=$3,pin_hash=$4 WHERE event_id=$1 AND id=$2 RETURNING name",
            [id, participantId, c.tokenHash, c.pinHash],
            client,
          );
          if (!p) fail(404, "Participant not found.");
          await client.query(
            "DELETE FROM secreto_v2.sessions WHERE participant_id=$1",
            [participantId],
          );
          return invitation(participantId, p.name, c);
        });
        return respond({ invitation: result });
      }
      if (action === "draw" && !participantId && method === "POST") {
        await transaction(db, async (client) => {
          await event(id, client, true);
          const people = await rows(
            "SELECT id FROM secreto_v2.participants WHERE event_id=$1 ORDER BY id",
            [id],
            client,
          );
          const recipients = draw(people.map((p) => p.id));
          for (let i = 0; i < people.length; i++)
            await client.query(
              "UPDATE secreto_v2.participants SET recipient_id=$2 WHERE id=$1",
              [people[i].id, recipients[i]],
            );
          await client.query(
            "UPDATE secreto_v2.events SET drawn_at=now() WHERE id=$1",
            [id],
          );
        });
        return respond({ ok: true });
      }
      fail(404, "Not found.");
    } catch (error) {
      if (error.status === 429) headers["Retry-After"] = "900";
      if (error.status) return respond({ error: error.message }, error.status);
      if (error.code === "23505")
        return respond({ error: "Each participant needs a unique name." }, 409);
      // Never log query parameters, credentials, invitation tokens, or database errors.
      return respond(
        { error: "Secreto is temporarily unavailable. Please try again." },
        503,
      );
    }
  };
}
