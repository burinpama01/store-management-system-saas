-- Task 10/D (v0.34.1): atomic success recording for shared device profiles.
-- Called by the SERVER only after a test print bound to the AI request actually
-- succeeded (cloud-verified) — never from a client boolean.
create or replace function public.record_device_profile_success(
  p_platform text,
  p_printer_model text,
  p_channel text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.device_profiles (platform, printer_model, channel, success_count, updated_at)
  values (p_platform, p_printer_model, p_channel, 1, now())
  on conflict (platform, printer_model, channel)
  do update set success_count = public.device_profiles.success_count + 1, updated_at = now();
$$;

grant execute on function public.record_device_profile_success(text, text, text) to authenticated;