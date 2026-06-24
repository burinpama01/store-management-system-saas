-- Enforce one default option per single-choice modifier group.
-- Multiple-choice groups may keep more than one default.

with ranked_defaults as (
  select
    mo.id,
    row_number() over (
      partition by mo.modifier_group_id
      order by mo.sort_order, mo.id
    ) as default_rank
  from modifier_options mo
  join modifier_groups mg on mg.id = mo.modifier_group_id
  where mg.selection_type = 'single'
    and mo.is_default = true
)
update modifier_options mo
   set is_default = false
  from ranked_defaults rd
 where mo.id = rd.id
   and rd.default_rank > 1;

with ranked_template_defaults as (
  select
    mot.id,
    row_number() over (
      partition by mot.group_template_id
      order by mot.sort_order, mot.id
    ) as default_rank
  from catalog_modifier_option_templates mot
  join catalog_modifier_group_templates mgt on mgt.id = mot.group_template_id
  where mgt.selection_type = 'single'
    and mot.is_default = true
)
update catalog_modifier_option_templates mot
   set is_default = false,
       updated_at = now()
  from ranked_template_defaults rd
 where mot.id = rd.id
   and rd.default_rank > 1;

create or replace function ensure_single_modifier_option_default()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.is_default is distinct from true then
    return new;
  end if;

  perform 1
    from modifier_groups
   where id = new.modifier_group_id
     and selection_type = 'single'
   for update;

  if not found then
    return new;
  end if;

  update modifier_options
     set is_default = false
   where modifier_group_id = new.modifier_group_id
     and id <> new.id
     and is_default = true;

  return new;
end;
$$;

drop trigger if exists modifier_options_single_default_guard on modifier_options;
create trigger modifier_options_single_default_guard
before insert or update of is_default, modifier_group_id on modifier_options
for each row
execute function ensure_single_modifier_option_default();

create or replace function ensure_single_modifier_option_template_default()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.is_default is distinct from true then
    return new;
  end if;

  perform 1
    from catalog_modifier_group_templates
   where id = new.group_template_id
     and selection_type = 'single'
   for update;

  if not found then
    return new;
  end if;

  update catalog_modifier_option_templates
     set is_default = false,
         updated_at = now()
   where group_template_id = new.group_template_id
     and id <> new.id
     and is_default = true;

  return new;
end;
$$;

drop trigger if exists catalog_modifier_option_templates_single_default_guard on catalog_modifier_option_templates;
create trigger catalog_modifier_option_templates_single_default_guard
before insert or update of is_default, group_template_id on catalog_modifier_option_templates
for each row
execute function ensure_single_modifier_option_template_default();
