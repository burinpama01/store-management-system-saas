-- Run only against the isolated schema-only local verification database.
\set ON_ERROR_STOP on
do $$ begin if current_database() not like 'storeos_native_verify_%' then raise exception 'isolated verification database required'; end if; end $$;
begin;
insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000001','native-test@example.invalid');
insert into organizations(id,name,slug,owner_id) values('20000000-0000-4000-8000-000000000002','Native test','native-test','10000000-0000-4000-8000-000000000001');
insert into stores(id,organization_id,name,slug) values('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','Native test','native-test');
insert into memberships(organization_id,user_id,store_id,role,joined_at) values('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','owner',now());
insert into categories(id,organization_id,store_id,name) values('40000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003','Test');
insert into products(id,organization_id,store_id,category_id,name,base_price) values('50000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000004','Test',65);
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select set_config('request.jwt.claim.sub','',false);
do $$
declare s uuid := '30000000-0000-4000-8000-000000000003';
 u uuid := '10000000-0000-4000-8000-000000000001';
 k text := 'native:'||s||':'||u||':60000000-0000-4000-8000-000000000006';
 tomb text := 'native:'||s||':'||u||':70000000-0000-4000-8000-000000000007';
 items jsonb := '[{"product_id":"50000000-0000-4000-8000-000000000005","product_name":"Test","quantity":1,"unit_price":65,"total_price":65,"modifiers":[]}]';
 a uuid; b uuid; r jsonb; claims text := current_setting('request.jwt.claims');
begin
 if has_function_privilege('authenticated','public.create_native_pos_order(uuid,text,uuid,text,numeric,jsonb)','EXECUTE') then raise exception 'authenticated privilege'; end if;
 if has_function_privilege('anon','public.cancel_native_pos_operation(uuid,text,uuid)','EXECUTE') then raise exception 'anon privilege'; end if;
 a := create_native_pos_order(s,k,u,'NATIVE-TEST',65,items);
 b := create_native_pos_order(s,k,u,'NATIVE-TEST-REPLAY',65,items);
 if a is distinct from b then raise exception 'duplicate order'; end if;
 if a is null then raise exception 'missing order id'; end if;
 if current_setting('request.jwt.claims') is distinct from claims or current_setting('request.jwt.claim.sub') is distinct from '' then raise exception 'claims not restored'; end if;
 r := cancel_native_pos_operation(s,k,u);
 if r->>'outcome' is distinct from 'existing' or (r->>'orderId')::uuid is distinct from a then raise exception 'existing cancellation'; end if;
 r := cancel_native_pos_operation(s,tomb,u);
 if r->>'outcome' is distinct from 'not_created' then raise exception 'tombstone missing'; end if;
 if not ((null::jsonb->>'outcome') is distinct from 'existing') or not (('{}'::jsonb->>'outcome') is distinct from 'not_created') then raise exception 'null-safe assertion regression'; end if;
 begin
   perform create_native_pos_order(s,tomb,u,'NATIVE-DELAYED',65,items);
   raise exception 'delayed create accepted';
 exception when others then
   if sqlerrm <> 'native_operation_cancelled' then raise; end if;
 end;
 if (select count(*) from orders where store_id=s) <> 1 then raise exception 'unexpected order count'; end if;
 begin
   perform create_native_pos_order(s,replace(k,u::text,'80000000-0000-4000-8000-000000000008'),'80000000-0000-4000-8000-000000000008','SPOOF',65,items);
   raise exception 'spoof accepted';
 exception when others then
   if sqlerrm <> 'no_store_access' then raise; end if;
 end;
 raise notice 'PASS: replay/cancel/tombstone/actor/claims/grants';
end $$;
commit;
