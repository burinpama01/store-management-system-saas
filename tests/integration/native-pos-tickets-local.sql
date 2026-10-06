-- Run only after the migration in an isolated verification database. Rolls back fixtures.
\set ON_ERROR_STOP on
do $$ begin if current_database() not like 'storeos_native_verify_%' then raise exception 'isolated verification database required'; end if; end $$;
begin;
insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000001','native-ticket-test@example.invalid'),('10000000-0000-4000-8000-000000000002','native-ticket-other@example.invalid');
insert into organizations(id,name,slug,owner_id) values('20000000-0000-4000-8000-000000000002','Native ticket test','native-ticket-test','10000000-0000-4000-8000-000000000001');
insert into stores(id,organization_id,name,slug) values('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','Native ticket test','native-ticket-test');
insert into memberships(organization_id,user_id,store_id,role,joined_at) values('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','owner',now());
select set_config('request.jwt.claims','{"role":"service_role"}',false);
do $$
declare s uuid := '30000000-0000-4000-8000-000000000003'; o uuid := '20000000-0000-4000-8000-000000000002'; u uuid := '10000000-0000-4000-8000-000000000001'; t uuid := '40000000-0000-4000-8000-000000000004'; c uuid := '50000000-0000-4000-8000-000000000005';
 cart jsonb := '{"storeId":"30000000-0000-4000-8000-000000000003","subtotal":65,"discount":0,"total":65,"items":[{"productId":"60000000-0000-4000-8000-000000000006","quantity":1,"unitPrice":65,"totalPrice":65,"modifiers":[]}]}';
 r jsonb; saved jsonb; expected jsonb; stamp timestamptz;
begin
 if has_table_privilege('authenticated','public.native_pos_saved_tickets','SELECT') then raise exception 'native tickets exposed'; end if;
 if has_table_privilege('authenticated','public.native_pos_ticket_claims','SELECT') then raise exception 'claims exposed'; end if;
 if has_function_privilege('authenticated','public.native_pos_claim_ticket(uuid,uuid,uuid,uuid,uuid,timestamptz,jsonb,jsonb)','EXECUTE') then raise exception 'claim exposed'; end if;
 saved := native_pos_save_ticket(t,s,o,u,'Test',cart);
 if saved->'ticket'->>'id' is distinct from t::text then raise exception 'save failed'; end if;
 if native_pos_save_ticket(t,s,o,u,'Test',cart) is distinct from saved then raise exception 'save replay changed'; end if;
 if not(native_pos_save_ticket(t,s,o,u,'Other',cart) ? 'error') then raise exception 'overwrite accepted'; end if;
 stamp := (saved->'ticket'->>'updatedAt')::timestamptz;
 expected := jsonb_build_object('id',t,'label','Test','lines','[]'::jsonb,'checkoutOperationId',c);
 r := native_pos_claim_ticket(c,t,s,o,u,stamp - interval '1 second',cart,expected);
 if not(r ? 'error') or not exists(select 1 from native_pos_saved_tickets where id=t) then raise exception 'stale claim lost ticket'; end if;
 r := native_pos_claim_ticket(c,t,s,o,u,stamp,cart || '{"total":66}',expected);
 if not(r ? 'error') then raise exception 'changed snapshot accepted'; end if;
 r := native_pos_claim_ticket(c,t,s,o,u,stamp,cart,expected);
 if r is distinct from expected or exists(select 1 from native_pos_saved_tickets where id=t) then raise exception 'claim failed'; end if;
 if native_pos_claim_ticket(c,t,s,o,u,stamp,cart,expected) is distinct from expected then raise exception 'claim replay failed'; end if;
 if native_pos_ticket_result(c,t,s,u) is distinct from expected then raise exception 'recovery failed'; end if;
 if not(native_pos_claim_ticket('50000000-0000-4000-8000-000000000009',t,s,o,u,stamp,cart,expected) ? 'error') then raise exception 'second consumption accepted'; end if;
 if not(native_pos_save_ticket(t,s,o,u,'Test',cart) ? 'error') then raise exception 'consumed ticket resurrected'; end if;
 begin
   perform native_pos_ticket_result(c,t,s,'10000000-0000-4000-8000-000000000002');
   raise exception 'cross actor accepted';
 exception when others then if sqlerrm <> 'no_store_access' then raise; end if; end;
 if exists(select 1 from pos_saved_tickets where id=t) then raise exception 'native ticket leaked to legacy web'; end if;
end $$;
rollback;
