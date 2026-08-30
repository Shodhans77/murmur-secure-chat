# Safety and security baseline

This application is designed so that security decisions are enforced by the
server and Supabase policies, not by the browser UI.

## What is protected

- Authentication first: Supabase Auth creates and manages the user session.
  Passwords never travel through Socket.IO and are not stored by this project.
- Private rooms: every socket connection presents a Supabase access token.
  The server verifies it and checks database membership before joining, reading
  history, typing, sending a message, or reporting.
- No client identity trust: the server derives the sender from the verified
  token. It ignores any browser-supplied username, room membership, or author.
- Private media: the chat-media bucket is private. Media paths are
  user-scoped, uploads are restricted to five safe MIME types and 25 MB, and
  temporary signed URLs are issued only to allowed room members.
- Abuse controls: users can block authors (past and new messages are hidden
  for the blocker) and report specific messages. Reports are kept for review.
- Abuse resistance: restrictive CORS, Helmet headers, HTTP and socket
  rate limits, schema validation, file-count limits, and server-side attachment
  verification reduce common misuse and spam.
- Accessible animation: the interface honours prefers-reduced-motion.

## Before production

1. Enable email confirmation and configure approved redirect URLs in
   Supabase Auth.
2. Run supabase/migrations/0001_secure_private_chat.sql.
3. Put only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the client.
   Keep SUPABASE_SERVICE_ROLE_KEY only in the server environment.
4. Replace the development CLIENT_ORIGIN with the exact HTTPS production
   domain. Never use an asterisk.
5. Deploy behind HTTPS, keep Node and dependencies patched, and send server
   logs to a protected monitoring service.
6. Define who reviews reports, a response-time target, a retention period,
   and an escalation path for credible threats or illegal content.
7. Add content moderation before broad or public rollout. File type and size
   checks are not image or video safety moderation.

## Important limits

This is private-room access control, not end-to-end encryption. Supabase and
the trusted server can process message metadata and content. Do not claim E2EE
unless an independently reviewed encryption protocol, key management design,
and recovery policy have been added.

Invite codes are secrets with a seven-day lifetime. Share them only with
trusted people. A future moderation dashboard should add expiry rotation,
member removal, report triage, audit logs, and media scanning.

