-- Rich POS saved ticket context for cashier UX.
-- Applied after the base pos_saved_tickets table; keep additive for production safety.

alter table pos_saved_tickets
  add column if not exists table_id uuid references tables(id) on delete set null,
  add column if not exists table_number text,
  add column if not exists customer_name text,
  add column if not exists note text,
  add column if not exists buffet_session_id uuid;

create index if not exists pos_saved_tickets_store_table_idx
  on pos_saved_tickets(store_id, table_id, updated_at desc)
  where table_id is not null;

create index if not exists pos_saved_tickets_store_customer_idx
  on pos_saved_tickets(store_id, lower(customer_name))
  where customer_name is not null;

create or replace function validate_pos_saved_ticket_table_store()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.table_id is not null
    and not exists (
      select 1
        from tables
       where tables.id = new.table_id
         and tables.store_id = new.store_id
    ) then
    raise exception 'โต๊ะไม่อยู่ในร้านของตั๋ว';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_pos_saved_ticket_table_store on pos_saved_tickets;
create trigger validate_pos_saved_ticket_table_store
  before insert or update of table_id, store_id on pos_saved_tickets
  for each row execute function validate_pos_saved_ticket_table_store();

create or replace function delete_pos_saved_ticket_and_close_table(
  p_ticket_id uuid,
  p_store_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket record;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select id, organization_id, table_id
    into v_ticket
    from pos_saved_tickets
   where id = p_ticket_id
     and store_id = p_store_id
   for update;

  if not found then
    raise exception 'ไม่พบตั๋วที่ต้องการลบ';
  end if;

  if not auth_user_role_in_store(v_ticket.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ลบตั๋ว';
  end if;

  if v_ticket.table_id is not null then
    update tables
       set status = 'available',
           current_session_id = null,
           session_started_at = null,
           session_expires_at = null,
           updated_at = now()
     where id = v_ticket.table_id
       and store_id = p_store_id;
  end if;

  delete from pos_saved_tickets
   where id = p_ticket_id
     and store_id = p_store_id;
end;
$$;

revoke execute on function delete_pos_saved_ticket_and_close_table(uuid, uuid) from public, anon;
grant execute on function delete_pos_saved_ticket_and_close_table(uuid, uuid) to authenticated;
