-- Run this migration in the Supabase SQL editor, or apply it with the
-- Supabase CLI. It creates private rooms, messages, reports, blocks, and a
-- private media bucket. The browser never receives a service-role key.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 60),
  created_by uuid not null references public.profiles(id) on delete cascade,
  invite_code text not null unique default encode(gen_random_bytes(18), 'hex')
    check (char_length(invite_code) = 36),
  invite_expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete restrict,
  body text not null default '' check (char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) between 3 and 220),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')),
  file_name text not null check (char_length(file_name) between 1 and 120),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400),
  created_at timestamptz not null default now()
);

create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  reason text not null check (char_length(reason) between 10 and 500),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved')),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_at_idx on public.messages(room_id, created_at desc);
create index if not exists room_members_user_id_idx on public.room_members(user_id);
create index if not exists message_attachments_message_id_idx on public.message_attachments(message_id);
create index if not exists reports_status_created_at_idx on public.reports(status, created_at);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_name text := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    case
      when char_length(requested_name) between 2 and 40 then requested_name
      else 'Member'
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfills profiles for projects that already have test users.
insert into public.profiles (id, display_name)
select
  id,
  case
    when char_length(trim(coalesce(raw_user_meta_data ->> 'display_name', ''))) between 2 and 40
      then trim(raw_user_meta_data ->> 'display_name')
    else 'Member'
  end
from auth.users
on conflict (id) do nothing;

create or replace function public.add_room_owner()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.room_members (room_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (room_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_room_created on public.rooms;
create trigger on_room_created
  after insert on public.rooms
  for each row execute procedure public.add_room_owner();

create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = target_room_id and user_id = auth.uid()
  );
$$;

create or replace function public.can_access_attachment(target_path text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.message_attachments attachment
    join public.messages message on message.id = attachment.message_id
    join public.room_members member on member.room_id = message.room_id
    where attachment.storage_path = target_path
      and member.user_id = auth.uid()
      and not exists (
        select 1 from public.blocked_users blocked
        where blocked.blocker_id = auth.uid()
          and blocked.blocked_id = message.author_id
      )
  );
$$;

create or replace function public.is_unattached(target_path text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select not exists (
    select 1 from public.message_attachments
    where storage_path = target_path
  );
$$;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.blocked_users enable row level security;
alter table public.reports enable row level security;

create policy "Users read their profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy "Users create their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "Members read private rooms"
  on public.rooms for select to authenticated
  using (public.is_room_member(id));

create policy "Users create rooms"
  on public.rooms for insert to authenticated
  with check (created_by = auth.uid());

create policy "Owners update their rooms"
  on public.rooms for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

create policy "Members read room membership"
  on public.room_members for select to authenticated
  using (public.is_room_member(room_id));

create policy "Members read room messages"
  on public.messages for select to authenticated
  using (
    public.is_room_member(room_id)
    and not exists (
      select 1 from public.blocked_users blocked
      where blocked.blocker_id = auth.uid() and blocked.blocked_id = author_id
    )
  );

create policy "Members send their own messages"
  on public.messages for insert to authenticated
  with check (
    public.is_room_member(room_id)
    and author_id = auth.uid()
  );

create policy "Members read allowed attachments"
  on public.message_attachments for select to authenticated
  using (
    exists (
      select 1 from public.messages message
      where message.id = message_id
        and public.is_room_member(message.room_id)
        and not exists (
          select 1 from public.blocked_users blocked
          where blocked.blocker_id = auth.uid() and blocked.blocked_id = message.author_id
        )
    )
  );

create policy "Authors attach to their own messages"
  on public.message_attachments for insert to authenticated
  with check (
    exists (
      select 1 from public.messages message
      where message.id = message_id
        and message.author_id = auth.uid()
        and public.is_room_member(message.room_id)
    )
  );

create policy "Users manage their own blocks"
  on public.blocked_users for select to authenticated
  using (blocker_id = auth.uid());

create policy "Users create their own blocks"
  on public.blocked_users for insert to authenticated
  with check (blocker_id = auth.uid() and blocker_id <> blocked_id);

create policy "Users remove their own blocks"
  on public.blocked_users for delete to authenticated
  using (blocker_id = auth.uid());

create policy "Users submit reports"
  on public.reports for insert to authenticated
  with check (reporter_id = auth.uid());

create policy "Users read their own reports"
  on public.reports for select to authenticated
  using (reporter_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do update
set public = false,
    file_size_limit = 26214400,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];

create policy "Users upload only their own safe media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(coalesce(metadata ->> 'mimetype', '')) in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')
    and coalesce((metadata ->> 'size')::bigint, 0) <= 26214400
  );

create policy "Members read only permitted private media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and (owner_id = auth.uid() or public.can_access_attachment(name))
  );

create policy "Users remove only unposted media they own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat-media'
    and owner_id = auth.uid()
    and public.is_unattached(name)
  );

