# Supabase migration record

Project: `idcammoqdzqwyuacywug`

Applied on 2026-10-27 through the authenticated Supabase Management SQL API:
`migrations/202610270001_secreto_v2.sql` (HTTP 201).

Before application, inspection covered columns, RLS, policies, grants,
constraints, indexes, app-role existence, and the `public.secreto_draw(uuid)`
definition and permissions. The existing `public.secreto_events` and
`public.secreto_participants` tables both contained zero records. Neither table
nor the legacy draw function was changed or deleted.

Verified after application:

- `secreto_v2.events`, `participants`, `sessions`, and `attempts` exist.
- All four tables have RLS enabled and grants for `secreto_app`.
- `anon` and `authenticated` have no USAGE permission on `secreto_v2`.
- `secreto_app` has schema USAGE permission.
- A write/constraint smoke test inserted an event, two participants, assignments,
  a session, and a rate-limit record using the migration connection. A self-match
  correctly raised a check violation. The entire transaction was rolled back.
- Legacy records were preserved. No test data is intended to remain.

The management connection denied SET ROLE to `secreto_app`; the successful
write test therefore used the migration connection, not a production runtime
login. This does not establish end-to-end application readiness. Provisioning
and verifying a dedicated runtime login, the correct pooler DATABASE_URL,
organizer password hash, Netlify environment variables, and live application
workflows remain separate deployment steps. No credentials are recorded here.

Do not reapply the initial CREATE SCHEMA migration to this project.
