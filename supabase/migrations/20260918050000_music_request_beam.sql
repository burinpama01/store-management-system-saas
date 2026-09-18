-- ขอเพลง (โดเนท) จ่ายด้วย Beam QR — ร้านที่เปิด Beam: ไม่ต้องแนบสลิป
--
-- gateway_payments.music_request_id ผูกรายการชำระ Beam กับคำขอเพลง (1:1)
-- trigger: เมื่อ Beam ยืนยัน PAID (webhook หรือ lookup ผ่าน API — จุดเดียวไม่ว่าทางไหน)
--          และยอดตรงกับยอดโดเนท → คำขอเพลง verified + approved เข้าคิวทันที
--          ยอดไม่ตรง → ไม่ยืนยันอัตโนมัติ (ร้านตรวจเองที่ประวัติ Beam)
-- ร้านที่ไม่มี Beam ใช้ PromptPay + ตรวจสลิปเดิม
-- additive

alter table public.gateway_payments
  add column if not exists music_request_id uuid references public.music_requests(id) on delete set null;

create unique index if not exists gateway_payments_music_request_unique
  on public.gateway_payments (music_request_id)
  where music_request_id is not null;

create or replace function public.promote_music_request_on_gateway_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.music_requests%rowtype;
begin
  select *
  into v_req
  from public.music_requests
  where id = new.music_request_id
    and store_id = new.store_id
  for update;

  if not found or v_req.donation_status = 'verified' then
    return new;
  end if;

  if round(v_req.donation_amount, 2) is distinct from round(new.amount, 2) then
    return new;
  end if;

  update public.music_requests
  set donation_status = 'verified',
      donation_ref = 'BEAM:' || new.id::text,
      status = 'approved',
      decided_at = now(),
      updated_at = now()
  where id = v_req.id;

  return new;
end;
$$;

revoke all on function public.promote_music_request_on_gateway_paid() from public;
revoke execute on function public.promote_music_request_on_gateway_paid() from anon, authenticated;

drop trigger if exists promote_music_request_on_gateway_paid on public.gateway_payments;
create trigger promote_music_request_on_gateway_paid
  after update of status on public.gateway_payments
  for each row
  when (new.music_request_id is not null and new.status = 'PAID' and old.status is distinct from 'PAID')
  execute function public.promote_music_request_on_gateway_paid();
