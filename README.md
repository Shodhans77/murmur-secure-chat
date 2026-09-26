# Murmur — safer real-time chat

This is a redesigned version of the real-time chat app: sign in before chat,
create a private room, join trusted rooms with a time-limited invite, and share
approved photos or videos from a device gallery.

## Local setup

1. Apply every SQL file in supabase/migrations in filename order. This builds
   the private chat schema and its later security hardening.
2. Copy client/.env.example to client/.env and add the Supabase project URL
   and publishable key.
3. Copy server/.env.example to server/.env and add the project URL and
   server-only service role key. Set CLIENT_ORIGIN to the Vite URL.
4. In two terminals run:

   cd client
   npm install
   npm run dev

   cd server
   npm install
   npm run dev

The first account can create a private room. The creator receives a seven-day
invite code once; share it only with trusted people.

See SECURITY.md for the implemented safety controls and the production work
that remains.

## Vercel deployment

Deploy this repository as two Vercel projects:

1. **murmur-secure-chat-web** — set the Vercel root directory to client.
   Set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and VITE_SERVER_URL.
2. **murmur-secure-chat-api** — set the Vercel root directory to server.
   Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and CLIENT_ORIGIN.

VITE_SERVER_URL must point to the API deployment URL. CLIENT_ORIGIN must be
the exact web deployment URL. After setting either value, redeploy the
affected Vercel project.

The API uses Vercel WebSocket support. For broad production use, add a
cross-instance Socket.IO adapter (for example Redis) because Vercel may place
connections on different function instances.
