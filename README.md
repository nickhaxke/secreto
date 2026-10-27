# Secreto V2

Mobile-first Secret Santa with a private organizer dashboard, one-time draws,
WhatsApp invitations, six-digit PINs, and an animated gift reveal.

## Local development

Requires Node 22.13+ (Node 24 recommended).

```sh
npm ci
npm run dev
```

The local app listens on port 3000. Sign in with `secreto-local-only`.
This is an explicit, isolated development mode using an in-memory PostgreSQL
engine (PGlite). Data disappears on restart. This password and database are
never used by Netlify Functions. `npm start` instead requires real configuration.

```sh
npm test
npm run build
npm run test:e2e
```

Browser tests use Chromium at `/usr/bin/chromium`; override `CHROMIUM_PATH` for
another installed Chromium executable. Screenshots and traces go to ignored
`test-results/`. Desktop and mobile tests exercise the full invitation flow.

For genuine multi-connection concurrency and runtime-role tests, start an
isolated PostgreSQL database and set `TEST_DATABASE_URL`. Tests require a local
database name ending in `_test` and reset only its `secreto_v2` schema. Never
point tests at production. Without this variable, the same suite uses PGlite;
its connections are serialized and do not demonstrate real database concurrency.

## Architecture

- `public/`: static HTML, CSS, and browser JavaScript. No database credentials.
- `netlify/functions/api.js`: Netlify v2 request handler.
- `netlify/functions/lib/`: authorization, validation, database transactions.
- `supabase/migrations/`: proposed, versioned private database schema.
- `scripts/inspect.sql`: schema/RLS/function/grant/index/constraint inventory.
- `tests/`: API, database, concurrency, privacy, and browser tests.

There is one organizer account, suitable for the specified private installation.
Every organizer session can manage every event. This is not a multi-tenant service.
Progress refreshes every ten seconds while an event page is visible.

## Security model

Organizer passwords and PINs use Node scrypt with unique 128-bit salts.
Invitation and session tokens have 256 bits of cryptographic randomness; only
SHA-256 hashes are stored. Production sessions use `__Host-` Secure, HttpOnly,
SameSite=Strict cookies with an eight-hour database expiry. No auth data is put
in localStorage. State-changing endpoints require the configured exact origin
and JSON content type. Authentication rate limits are atomic database upserts,
including per-invitation limits across IP addresses. Netlify's trusted context
IP is used, not client-supplied forwarded headers.

All event changes and draws lock the event row. The draw samples uniform random
permutations until no self-match remains, using random-js's Node crypto engine.
Database constraints additionally enforce unique recipients, no self-match,
and same-event recipients. Completed events cannot be edited through the API.
Dashboard queries select only public event fields and participant status,
never pairings or credential hashes. Reveals require both the authenticated
participant and their matching invitation token.

Invitation URLs use fragments so tokens do not enter HTTP request URLs or
referrers. Credentials are shown once when generated, can be downloaded by the
organizer, and remain only in page memory. Reloading clears them. Replacement
invitations invalidate the previous token, PIN, and participant sessions while
preserving the assignment. WhatsApp sharing deliberately includes the private
link and PIN; organizers must send it only to its intended recipient.

The private schema is not exposed through Supabase's public REST API. RLS grants
access only to the server's dedicated `secreto_app` role. The browser never
connects to Supabase. This backend uses PostgreSQL directly through Supabase's
TLS connection/pooler, rather than a service-role REST key.

## Existing Supabase and production deployment

Target project: `idcammoqdzqwyuacywug`. Target Netlify site: `secreto-drnick`.
**The existing live schema has not been inspected or modified. Integration with
legacy tables/functions is pending access and compatibility review.** The new
migration uses `secreto_v2` and does not overwrite unknown existing data. It must
not be applied blindly. No automatic migration runs during builds or requests.

1. Rotate previously exposed Supabase credentials, database passwords, and any
   dependent credentials. Revoke old keys and update existing consumers.
2. Supply a verified TLS PostgreSQL connection securely in `DATABASE_URL`, using
   the existing project's direct connection or Supavisor session pooler. Run
   `npm run db:inspect` with an authorized inspection account. Review existing
   tables, functions, RLS, grants, indexes and constraints. Treat inventory output
   as private: existing function definitions may contain sensitive legacy text.
3. Reconcile the proposed migration with the existing schema and draw function.
   Decide whether existing event data needs a reviewed import. After review,
   an authorized migration account can run
   `SECRETO_SCHEMA_REVIEWED=true npm run db:migrate`. Do not apply on a schema
   name collision. The migration intentionally fails instead of overwriting it.
4. Provision a dedicated LOGIN role with a strong securely generated password,
   no superuser/createdb/createrole rights, membership in `secreto_app`, and role
   inheritance enabled. Use its connection in Netlify, not the migration owner.
   Verify the chosen Supabase pooler accepts this role. Keep `secreto_v2` out of
   exposed API schemas. TLS verification stays enabled; supply `DATABASE_CA_CERT`
   if the connection requires Supabase's CA. Never use `rejectUnauthorized=false`.
5. Configure Netlify Functions-scoped environment variables:
   - `DATABASE_URL`: the dedicated server role connection, with rotated password.
   - `DATABASE_CA_CERT`: PEM CA only if required by the verified connection.
   - `SECRETO_ADMIN_PASSWORD_HASH`: scrypt output from `npm run password:hash --silent`.
     Feed a 14-256 character password through stdin, not a command argument. Use
     a secure local terminal or secret-manager pipeline; never paste it in chat.
   - `SECRETO_SESSION_SECRET`: at least 32 random characters, used to HMAC rate-limit identities.
   - `SECRETO_ORIGIN`: exact HTTPS production origin, without a trailing slash.
   - `SECRETO_CREDENTIALS_ROTATED`: `true` only after actual rotation/revocation.
6. Link the existing Netlify site to this repository, using the committed
   `netlify.toml`. Deploy using the existing project's dashboard or an authorized
   Netlify CLI session. Do not create a duplicate site or database project.
7. Verify organizer login, event writes, atomic draw, private invitation/PIN,
   reveal, repeated reveal, progress, and unauthorized access on the live site.
   Use clearly labeled test events and never inspect real users' matches.

Deployment access requires a Netlify account/token authorized for the existing
site. Schema inspection requires Supabase project access or an authorized
database connection. `SUPABASE_ACCESS_TOKEN` can support management inspection;
it is not the runtime database credential. No production secrets belong in Git,
build output, application responses, or logs.

Production handlers fail closed with 503 if secure configuration or credential
rotation confirmation is missing. A successful build is not a verified production
deployment. See the delivery report for the checks actually executed.

## Asset credit

The gift favicon is from [Twemoji](https://github.com/twitter/twemoji), copyright
Twitter, Inc. and other contributors, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The animated gift box
is implemented locally with CSS and does not load third-party scripts or assets.
