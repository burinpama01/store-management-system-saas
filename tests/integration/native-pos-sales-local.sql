-- Synthetic fixtures only, isolated local database. Always rolls back.
\set ON_ERROR_STOP on
do $$ begin if current_database() not like 'storeos_native_verify_%' then raise exception 'isolated verification database required'; end if; end $$;
begin;
insert into auth.users(id,email) values('a1000000-0000-4000-8000-000000000001','native-sales@example.invalid');
insert into organizations(id,name,slug,owner_id) values('a2000000-0000-4000-8000-000000000002','Native sales test','native-sales-test','a1000000-0000-4000-8000-000000000001');
insert into stores(id,organization_id,name,slug) values('a3000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000002','Native sales test','native-sales-test'),('a3000000-0000-4000-8000-000000000004','a2000000-0000-4000-8000-000000000002','Other test','native-sales-other');
insert into memberships(organization_id,user_id,store_id,role,joined_at) values('a2000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000003','owner',now());
insert into categories(id,organization_id,store_id,name) values('a4000000-0000-4000-8000-000000000004','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000003','Sales');
insert into products(id,organization_id,store_id,category_id,name,base_price) values('a5000000-0000-4000-8000-000000000005','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000003','a4000000-0000-4000-8000-000000000004','Sales test',100);
insert into customers(id,organization_id,store_id,name) values('a6000000-0000-4000-8000-000000000006','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000003','Synthetic customer'),('a6000000-0000-4000-8000-000000000007','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000004','Foreign synthetic');
insert into coupons(id,organization_id,store_id,code,normalized_code,name,discount_type,discount_value,max_redemptions,stackable_with_manual_discount)
values('a7000000-0000-4000-8000-000000000007','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000003','SALES10','SALES10','Synthetic coupon','amount',10,1,true);
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select set_config('request.jwt.claim.sub','',false);
do $$
declare s uuid:='a3000000-0000-4000-8000-000000000003'; u uuid:='a1000000-0000-4000-8000-000000000001';
 c uuid:='a6000000-0000-4000-8000-000000000006'; v uuid:='a7000000-0000-4000-8000-000000000007';
 k text:='native:'||s||':'||u||':a8000000-0000-4000-8000-000000000008';
 k2 text:='native:'||s||':'||u||':a8000000-0000-4000-8000-000000000009';
 tomb text:='native:'||s||':'||u||':a8000000-0000-4000-8000-000000000010';
 items jsonb:='[{"product_id":"a5000000-0000-4000-8000-000000000005","product_name":"Sales test","quantity":1,"unit_price":100,"total_price":100,"modifiers":[]}]';
 a uuid; b uuid; claims text:=current_setting('request.jwt.claims');
begin
 if has_function_privilege('anon','public.create_native_pos_rewards_order(uuid,text,uuid,text,numeric,jsonb,numeric,numeric,text,uuid,uuid,numeric)','EXECUTE') or has_function_privilege('authenticated','public.create_native_pos_rewards_order(uuid,text,uuid,text,numeric,jsonb,numeric,numeric,text,uuid,uuid,numeric)','EXECUTE') then raise exception 'RPC exposed'; end if;
 a:=create_native_pos_rewards_order(s,k,u,'NATIVE-SALES',85,items,100,15,'manual',c,v,10);
 b:=create_native_pos_rewards_order(s,k,u,'NATIVE-SALES-REPLAY',85,items,100,15,'manual',c,v,10);
 if a is null or a is distinct from b then raise exception 'duplicate order'; end if;
 if not exists(select 1 from orders where id=a and customer_id=c and coupon_id=v and coupon_discount_amount=10 and discount=15 and total=85) then raise exception 'rewards/total mismatch'; end if;
 if (select count(*) from coupon_redemptions where coupon_id=v)<>1 then raise exception 'duplicate redemption'; end if;
 if current_setting('request.jwt.claims') is distinct from claims or current_setting('request.jwt.claim.sub') is distinct from '' then raise exception 'claims leaked'; end if;
 begin
   perform create_native_pos_rewards_order(s,k2,u,'OVERQUOTA',85,items,100,15,'manual',c,v,10);
   raise exception 'quota accepted';
 exception when others then if sqlerrm <> 'คูปองนี้ถูกใช้ครบจำนวนแล้ว' then raise; end if; end;
 begin
   perform create_native_pos_rewards_order(s,k2,u,'FOREIGN',100,items,100,0,null,'a6000000-0000-4000-8000-000000000007',null,0);
   raise exception 'foreign customer accepted';
 exception when others then if sqlerrm <> 'ลูกค้าไม่ถูกต้อง' then raise; end if; end;
 perform cancel_native_pos_operation(s,tomb,u);
 begin
   perform create_native_pos_rewards_order(s,tomb,u,'DELAYED',100,items,100,0,null,c,null,0);
   raise exception 'tombstone ignored';
 exception when others then if sqlerrm <> 'native_operation_cancelled' then raise; end if; end;
 if (select count(*) from orders where store_id=s)<>1 then raise exception 'failed transaction left order'; end if;
 raise notice 'PASS native sales atomic rewards/replay/quota/foreign-customer/tombstone/grants/claims';
end $$;
rollback;
