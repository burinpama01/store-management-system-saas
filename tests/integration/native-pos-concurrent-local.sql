\set ON_ERROR_STOP on
do $$ begin if current_database() not like 'storeos_native_verify_%' then raise exception 'isolated verification database required'; end if; end $$;
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_advisory_xact_lock(hashtext('30000000-0000-4000-8000-000000000003:native:30000000-0000-4000-8000-000000000003:10000000-0000-4000-8000-000000000001:90000000-0000-4000-8000-000000000009'));
select pg_sleep(1);
select create_native_pos_order('30000000-0000-4000-8000-000000000003','native:30000000-0000-4000-8000-000000000003:10000000-0000-4000-8000-000000000001:90000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','NATIVE-CONCURRENT',65,'[{"product_id":"50000000-0000-4000-8000-000000000005","product_name":"Test","quantity":1,"unit_price":65,"total_price":65,"modifiers":[]}]');
commit;
