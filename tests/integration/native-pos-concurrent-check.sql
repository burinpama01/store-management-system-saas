\set ON_ERROR_STOP on
do $$ begin if current_database() not like 'storeos_native_verify_%' then raise exception 'isolated verification database required'; end if; end $$;
do $$
begin
 if (select count(*) from orders where store_id='30000000-0000-4000-8000-000000000003' and order_number='NATIVE-CONCURRENT') <> 1 then
   raise exception 'concurrent creation must produce exactly one order';
 end if;
 raise notice 'PASS: concurrent creation produced exactly one order';
end $$;
