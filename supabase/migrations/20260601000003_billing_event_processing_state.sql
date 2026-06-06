-- Track Stripe webhook processing state so failed handlers can be retried.

alter table billing_events
  add column if not exists status text not null default 'processed'
    check (status in ('processing', 'processed', 'failed')),
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_attempt_id uuid,
  add column if not exists failed_at timestamptz,
  add column if not exists last_error text;

alter table billing_events
  alter column processed_at drop not null;

update billing_events
set status = 'processed'
where status is null;

create index if not exists billing_events_status_idx on billing_events(status);

create or replace function begin_billing_event_processing(
  p_stripe_event_id text,
  p_event_type text,
  p_processing_attempt_id uuid,
  p_stale_after interval default interval '15 minutes'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event billing_events%rowtype;
  v_now timestamptz := now();
begin
  insert into billing_events (
    stripe_event_id,
    event_type,
    status,
    processing_started_at,
    processing_attempt_id,
    processed_at,
    failed_at,
    last_error
  )
  values (
    p_stripe_event_id,
    p_event_type,
    'processing',
    v_now,
    p_processing_attempt_id,
    null,
    null,
    null
  )
  on conflict (stripe_event_id) do nothing
  returning * into v_event;

  if found then
    return 'process';
  end if;

  select *
    into v_event
    from billing_events
    where stripe_event_id = p_stripe_event_id
    for update;

  if not found then
    return 'retry_later';
  end if;

  if v_event.status = 'processed' then
    return 'skip';
  end if;

  if v_event.status = 'processing'
    and v_event.processing_started_at is not null
    and v_event.processing_started_at > v_now - p_stale_after then
    return 'retry_later';
  end if;

  update billing_events
     set event_type = p_event_type,
         status = 'processing',
         processing_started_at = v_now,
         processing_attempt_id = p_processing_attempt_id,
         failed_at = null,
         last_error = null
   where stripe_event_id = p_stripe_event_id;

  return 'process';
end;
$$;
