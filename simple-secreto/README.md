# Secreto Simple

Standalone HTML, CSS, and browser JavaScript backed by the existing Supabase
project. The folder includes the SQL schema and RPC functions. It does not use
the Netlify functions from the main application.

## Set up Supabase

1. In Supabase Authentication, create or invite your organizer account.
2. Open SQL Editor, paste `schema.sql`, and run it once. It creates an unexposed
   private schema and narrowly granted RPC functions. It leaves existing tables
   and draw functions alone.
3. Add your organizer user as an administrator in SQL Editor, substituting the
   sign-in email:

   ```sql
   INSERT INTO secreto_private.admins(user_id)
   SELECT id FROM auth.users WHERE lower(email)=lower('organizer@example.com')
   ON CONFLICT DO NOTHING;
   ```

   Check that one row was inserted. No admin user can access organizer actions
   until this explicit database grant exists.

The HTML client uses the project's public publishable key. It is designed to be
public; database credentials and service-role keys are never placed in this
folder. Organizer login uses Supabase Auth. Sessions and invitation tickets are
held in memory only. Participants authenticate through a private 256-bit link
and six-digit PIN; tokens and salted PIN hashes remain in the private schema.

## Run

Serve this folder with any static HTTP server, or publish only this folder as a
static site. Open `index.html` through that server. Opening the file directly
from `file://` is not supported by Supabase browser security policies.

The organizer creates events with at least two participants, shares each private
link and PIN, draws once, and tracks invitation progress. A reminder replaces a
participant's old link and PIN and keeps that participant's existing match.
Participant refresh clears the temporary session; entering the PIN again safely
opens the same match.
