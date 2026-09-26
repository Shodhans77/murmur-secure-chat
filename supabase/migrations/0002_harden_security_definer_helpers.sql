-- Keep SECURITY DEFINER helpers outside the API-exposed schema. The RLS
-- policies retain their internal references, but clients cannot call these
-- helpers as RPC endpoints or execute them directly.

create schema if not exists private;
revoke all on schema private from public;

alter function public.handle_new_user() set schema private;
alter function public.add_room_owner() set schema private;
alter function public.is_room_member(uuid) set schema private;
alter function public.can_access_attachment(text) set schema private;
alter function public.is_unattached(text) set schema private;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
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

create or replace function private.add_room_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.room_members (room_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (room_id, user_id) do nothing;
  return new;
end;
$$;

create or replace function private.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members
    where room_id = target_room_id
      and user_id = (select auth.uid())
  );
$$;

create or replace function private.can_access_attachment(target_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.message_attachments attachment
    join public.messages message on message.id = attachment.message_id
    join public.room_members member on member.room_id = message.room_id
    where attachment.storage_path = target_path
      and member.user_id = (select auth.uid())
      and not exists (
        select 1 from public.blocked_users blocked
        where blocked.blocker_id = (select auth.uid())
          and blocked.blocked_id = message.author_id
      )
  );
$$;

create or replace function private.is_unattached(target_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not exists (
      select 1 from public.message_attachments
      where storage_path = target_path
    );
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function private.add_room_owner() from public, anon, authenticated, service_role;
revoke all on function private.is_room_member(uuid) from public, anon, authenticated, service_role;
revoke all on function private.can_access_attachment(text) from public, anon, authenticated, service_role;
revoke all on function private.is_unattached(text) from public, anon, authenticated, service_role;
