-- Supabase installs this event-trigger helper to automatically enable RLS on
-- newly created public tables. It must not be executable through the API.
revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;

-- Cover foreign keys that are used for moderation, ownership, and cleanup.
create index if not exists blocked_users_blocked_id_idx on public.blocked_users(blocked_id);
create index if not exists messages_author_id_idx on public.messages(author_id);
create index if not exists reports_message_id_idx on public.reports(message_id);
create index if not exists reports_reporter_id_idx on public.reports(reporter_id);
create index if not exists rooms_created_by_idx on public.rooms(created_by);

-- Cache the authenticated user ID once per statement rather than once per row.
alter policy "Users read their profile" on public.profiles
  using (id = (select auth.uid()));

alter policy "Users create their own profile" on public.profiles
  with check (id = (select auth.uid()));

alter policy "Users update their own profile" on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy "Users create rooms" on public.rooms
  with check (created_by = (select auth.uid()));

alter policy "Owners update their rooms" on public.rooms
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

alter policy "Members read room messages" on public.messages
  using (
    private.is_room_member(room_id)
    and not exists (
      select 1 from public.blocked_users blocked
      where blocked.blocker_id = (select auth.uid())
        and blocked.blocked_id = author_id
    )
  );

alter policy "Members send their own messages" on public.messages
  with check (
    private.is_room_member(room_id)
    and author_id = (select auth.uid())
  );

alter policy "Members read allowed attachments" on public.message_attachments
  using (
    exists (
      select 1 from public.messages message
      where message.id = message_id
        and private.is_room_member(message.room_id)
        and not exists (
          select 1 from public.blocked_users blocked
          where blocked.blocker_id = (select auth.uid())
            and blocked.blocked_id = message.author_id
        )
    )
  );

alter policy "Authors attach to their own messages" on public.message_attachments
  with check (
    exists (
      select 1 from public.messages message
      where message.id = message_id
        and message.author_id = (select auth.uid())
        and private.is_room_member(message.room_id)
    )
  );

alter policy "Users manage their own blocks" on public.blocked_users
  using (blocker_id = (select auth.uid()));

alter policy "Users create their own blocks" on public.blocked_users
  with check (
    blocker_id = (select auth.uid())
    and blocker_id <> blocked_id
  );

alter policy "Users remove their own blocks" on public.blocked_users
  using (blocker_id = (select auth.uid()));

alter policy "Users submit reports" on public.reports
  with check (reporter_id = (select auth.uid()));

alter policy "Users read their own reports" on public.reports
  using (reporter_id = (select auth.uid()));

alter policy "Users upload only their own safe media" on storage.objects
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and lower(coalesce(metadata ->> 'mimetype', '')) in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')
    and coalesce((metadata ->> 'size')::bigint, 0) <= 26214400
  );

alter policy "Members read only permitted private media" on storage.objects
  using (
    bucket_id = 'chat-media'
    and (
      owner_id = (select auth.uid()::text)
      or private.can_access_attachment(name)
    )
  );

alter policy "Users remove only unposted media they own" on storage.objects
  using (
    bucket_id = 'chat-media'
    and owner_id = (select auth.uid()::text)
    and private.is_unattached(name)
  );
