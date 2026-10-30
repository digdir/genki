import type { Pool } from 'pg';

export const runtimeRole = 'genai_runtime';

const tenantTables = [
  'tenants',
  'conversations',
  'conversation_messages',
  'legacy_api_keys',
  'tenant_settings',
  'admin_audit',
  'support_sessions',
  'tenant_secrets',
  'tool_connections',
  'eval_test_sets',
  'eval_runs',
  'eval_feedback',
  'eval_candidates',
  'clients',
  'webhook_deliveries',
  'ingestion_executions',
  'trigger_runs',
  'api_key_policies',
];

const publishedTables = { definition_versions: 'tenant', config_entries: 'scope' };

const kernelTables = ['content_keys', 'erased_scopes', 'events', 'tasks', 'state'];

const platformTables = [
  'identities',
  'model_classifications',
  'setting_default_versions',
  'setting_locks',
  'judge_labels',
  'change_versions',
  'rate_limit_windows',
];

const definerFunctions = [
  'find_legacy_api_key(text)',
  'touch_legacy_api_key(text, timestamptz)',
  'platform_tenant_settings()',
  'platform_admin_audit()',
  'platform_support_sessions()',
  'find_eval_run(text)',
  'find_eval_candidate(text)',
  'platform_clients()',
  'platform_tenants()',
  'find_ingestion_execution(text)',
  'fail_stale_ingestion_executions(text, text[], text, text)',
  'find_api_key_policy(text)',
];

const platformAccess = `coalesce(current_setting('app.platform_access', true), '') <> ''`;

const tenantIsolation = (table: string, column = 'tenant') => [
  `alter table ${table} enable row level security`,
  `alter table ${table} force row level security`,
  `drop policy if exists tenant_isolation on ${table}`,
  `create policy tenant_isolation on ${table}
     using (${column} = current_setting('app.tenant', true))
     with check (${column} = current_setting('app.tenant', true))`,
  `drop policy if exists platform_access on ${table}`,
  `create policy platform_access on ${table} to current_user
     using (${platformAccess}) with check (${platformAccess})`,
];

const publishedIsolation = (table: string, column: string) => [
  `alter table ${table} enable row level security`,
  `alter table ${table} force row level security`,
  `drop policy if exists published_read on ${table}`,
  `create policy published_read on ${table} for select using (true)`,
  `drop policy if exists tenant_write on ${table}`,
  `create policy tenant_write on ${table} for insert
     with check (${column} = current_setting('app.tenant', true))`,
];

const migrations: string[] = [
  `create or replace function require_platform_access() returns void
     language plpgsql stable as $$ begin
       if not ${platformAccess} then
         raise exception 'a cross-tenant read needs an explicit platform access purpose'
           using errcode = 'insufficient_privilege';
       end if;
       if coalesce(current_setting('app.tenant', true), '') <> '' then
         raise exception 'a cross-tenant read is not allowed inside a tenant transaction'
           using errcode = 'insufficient_privilege';
       end if;
     end $$`,
  `create table if not exists content_keys (
     tenant text not null,
     scope text not null,
     wrapped bytea not null,
     created_at timestamptz not null default now(),
     primary key (tenant, scope)
   )`,
  `create table if not exists erased_scopes (
     tenant text not null,
     scope text not null,
     erased_at timestamptz not null default now(),
     primary key (tenant, scope)
   )`,
  `create table if not exists events (
     task text not null,
     seq integer not null,
     type text not null,
     v integer not null,
     ts timestamptz not null,
     actor jsonb not null,
     audience text,
     span jsonb,
     tenant text not null,
     scope text not null,
     envelope jsonb,
     payload bytea,
     primary key (task, seq)
   )`,
  `create index if not exists events_scope on events (tenant, scope)`,
  `create table if not exists tasks (
     id text primary key,
     tenant text not null,
     owner text not null,
     status text not null,
     principal jsonb not null,
     assignee jsonb,
     last_seq integer not null,
     created_at timestamptz not null,
     ended_at timestamptz,
     envelope jsonb not null,
     scope text not null,
     body bytea
   )`,
  `create index if not exists tasks_pending on tasks (status) where status = 'interrupted'`,
  `create index if not exists tasks_thread on tasks (tenant, (envelope->>'thread'))`,
  `create table if not exists state (
     key text primary key,
     v integer not null,
     tenant text not null,
     scope text not null,
     value bytea not null
   )`,
  `create index if not exists state_scope on state (tenant, scope)`,
  `create table if not exists tenants (
     org_number text primary key check (org_number ~ '^[0-9]{9}$'),
     name text,
     created_by text not null,
     created_at timestamptz not null default now()
   )`,
  ...tenantIsolation('tenants', 'org_number'),
  `create table if not exists conversations (
     id text primary key,
     tenant text not null,
     owner_hash text not null,
     agent_id text not null,
     tags jsonb not null default '[]',
     created bigint not null,
     body bytea not null
   )`,
  `create index if not exists conversations_owner on conversations (tenant, owner_hash, created desc)`,
  `create table if not exists conversation_messages (
     conversation text not null references conversations (id) on delete cascade,
     seq integer not null,
     tenant text not null,
     created bigint not null,
     body bytea not null,
     primary key (conversation, seq)
   )`,
  ...tenantIsolation('conversations'),
  ...tenantIsolation('conversation_messages'),
  `alter table conversation_messages add column if not exists parent_seq integer`,
  `create table if not exists definition_versions (
     kind text not null,
     tenant text not null,
     id text not null,
     version integer not null,
     definition jsonb not null,
     files jsonb not null default '{}',
     published_by text not null,
     published_at timestamptz not null,
     reason text not null,
     primary key (kind, tenant, id, version)
   )`,
  `create table if not exists identities (
     issuer text not null,
     subject text not null,
     person bytea not null,
     updated_at timestamptz not null default now(),
     primary key (issuer, subject)
   )`,
  `create table if not exists legacy_api_keys (
     id text primary key,
     digest char(64) unique not null,
     prefix text,
     last_four text,
     name text not null,
     tenant char(9) not null,
     legacy boolean not null default true,
     scopes text[] not null,
     dataset_grants text[] not null default '{}',
     agent_grants text[] not null default '{}',
     client_id text,
     revoked_at timestamptz,
     expires_at timestamptz,
     created_at timestamptz not null,
     last_used_at timestamptz,
     usage_count bigint not null default 0
   )`,
  ...tenantIsolation('legacy_api_keys'),
  `create or replace function find_legacy_api_key(p_digest text) returns setof legacy_api_keys
     language plpgsql security definer set search_path = public
     as $$
     declare previous text := current_setting('app.platform_access', true);
     begin
       perform set_config('app.platform_access', 'api-key-digest', true);
       return query select * from legacy_api_keys where digest = p_digest;
       perform set_config('app.platform_access', coalesce(previous, ''), true);
     end $$`,
  `create or replace function touch_legacy_api_key(p_id text, p_at timestamptz) returns void
     language plpgsql security definer set search_path = public
     as $$
     declare previous text := current_setting('app.platform_access', true);
     begin
       perform set_config('app.platform_access', 'api-key-usage', true);
       update legacy_api_keys set last_used_at = p_at, usage_count = usage_count + 1 where id = p_id;
       perform set_config('app.platform_access', coalesce(previous, ''), true);
     end $$`,
  `create table if not exists model_classifications (
     id text primary key,
     classification jsonb not null,
     updated_at timestamptz not null default now()
   )`,
  `create or replace function refuse_change() returns trigger language plpgsql
     as $$ begin raise exception '% is append-only', tg_table_name; end $$`,
  `create table if not exists setting_default_versions (
     key text not null,
     version integer not null check (version > 1),
     value bytea not null,
     changed_at timestamptz not null,
     changed_by text not null,
     reason text not null,
     primary key (key, version)
   )`,
  `create or replace trigger setting_default_versions_append_only before update or delete on setting_default_versions
     for each row execute function refuse_change()`,
  `create table if not exists setting_locks (
     key text primary key,
     reason text not null,
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists tenant_settings (
     tenant text primary key,
     body bytea not null,
     updated_at timestamptz not null default now()
   )`,
  ...tenantIsolation('tenant_settings'),
  `create or replace function platform_tenant_settings() returns setof tenant_settings
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from tenant_settings;
     end $$`,
  `create table if not exists admin_audit (
     seq bigint generated always as identity primary key,
     task text not null,
     tenant text not null,
     action text not null,
     actor text not null,
     on_behalf_of text,
     at timestamptz not null,
     outcome text not null check (outcome in ('applied', 'rejected')),
     target text not null,
     reason text not null
   )`,
  `create index if not exists admin_audit_tenant on admin_audit (tenant, seq)`,
  ...tenantIsolation('admin_audit'),
  `create or replace trigger admin_audit_append_only before update or delete on admin_audit
     for each row execute function refuse_change()`,
  `create or replace function platform_admin_audit() returns setof admin_audit
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from admin_audit order by seq;
     end $$`,
  `create table if not exists support_sessions (
     id text primary key,
     tenant text not null,
     operator text not null,
     reason text not null,
     opened_at timestamptz not null,
     expires_at timestamptz not null,
     ended_at timestamptz
   )`,
  ...tenantIsolation('support_sessions'),
  `alter table support_sessions add column if not exists operator_name text`,
  `create or replace function platform_support_sessions() returns setof support_sessions
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from support_sessions order by opened_at, id;
     end $$`,
  `create table if not exists tenant_secrets (
     tenant text not null,
     name text not null,
     value bytea not null,
     updated_at timestamptz not null default now(),
     primary key (tenant, name)
   )`,
  ...tenantIsolation('tenant_secrets'),
  `create table if not exists tool_connections (
     tenant text not null,
     id text not null,
     state jsonb not null,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     primary key (tenant, id)
   )`,
  ...tenantIsolation('tool_connections'),
  `do $$
     declare previous text := current_setting('app.platform_access', true);
     begin
       if exists (select 1 from information_schema.columns
                  where table_schema = current_schema() and table_name = 'tenant_secrets'
                    and column_name = 'allowed_hosts') then
         return;
       end if;
       alter table tenant_secrets add column allowed_hosts text[];
       perform set_config('app.platform_access', 'secret-hosts-migration', true);
       with addresses(tenant, ref, address) as (
         select c.tenant, c.state #>> '{connection,auth,secret}', a.address
           from tool_connections c
           cross join lateral unnest(array[
             c.state #>> '{connection,endpoint}',
             c.state #>> '{connection,documentUrl}',
             c.state #>> '{connection,auth,tokenUrl}']) as a(address)
         union all
         select c.tenant, c.state #>> '{connection,auth,secret}',
                'https://'
                || case when h.entry ->> 'host' like '%:%'
                        then '[' || (h.entry ->> 'host') || ']' else h.entry ->> 'host' end
                || case when coalesce((h.entry ->> 'port')::int, 443) = 443
                        then '' else ':' || (h.entry ->> 'port') end
           from tool_connections c
           cross join lateral jsonb_array_elements(
             coalesce(c.state #> '{connection,allow}', '[]'::jsonb)) as h(entry)
         union all
         select d.tenant, e #>> '{auth,secret}', e ->> 'url'
           from definition_versions d
           cross join lateral jsonb_path_query(d.definition,
             'strict $.** ? (@.auth.secret.type() == "string" && @.url.type() == "string")') as e
       ),
       origins(tenant, name, origin) as (
         select tenant, substr(ref, length('secret://tenant/' || tenant || '/') + 1),
                lower(substring(address from '^(https?://[^/?#]+)'))
           from addresses
          where ref like 'secret://tenant/' || tenant || '/%' and address ~ '^https?://'
       ),
       bound(tenant, name, hosts) as (
         select tenant, name,
                array_agg(distinct regexp_replace(
                  regexp_replace(origin, '^(https://[^/]+):443$', '\\1'),
                  '^(http://[^/]+):80$', '\\1'))
           from origins
          where origin is not null
          group by tenant, name
       )
       update tenant_secrets s set allowed_hosts = b.hosts
         from bound b
        where s.tenant = b.tenant and s.name = b.name;
       if to_regclass('config_entries') is not null then
         execute $catalog$
           with latest as (
             select distinct on (kind, scope, id) spec, deleted
               from config_entries
              where kind in ('knowledge-endpoint', 'model-endpoint')
              order by kind, scope, id, version desc
           ),
           refs(tenant, name, origin) as (
             select m[1], m[2], lower(substring(l.spec ->> 'baseURL' from '^(https?://[^/?#]+)'))
               from latest l
               cross join lateral regexp_match(l.spec #>> '{auth,secret}',
                 '^secret://tenant-(\\d{9})/([a-z0-9][a-z0-9._-]*)$') as m
              where not l.deleted
           ),
           bound(tenant, name, hosts) as (
             select tenant, name,
                    array_agg(distinct regexp_replace(
                      regexp_replace(origin, '^(https://[^/]+):443$', '\\1'),
                      '^(http://[^/]+):80$', '\\1'))
               from refs
              where origin is not null
              group by tenant, name
           )
           update tenant_secrets s
              set allowed_hosts = (select array_agg(distinct h order by h)
                                     from unnest(coalesce(s.allowed_hosts, '{}') || b.hosts) as h)
             from bound b
            where s.tenant = b.tenant and s.name = b.name
         $catalog$;
       end if;
       perform set_config('app.platform_access', coalesce(previous, ''), true);
     end $$`,
  `create table if not exists eval_test_sets (
     tenant text not null,
     id text not null,
     version integer not null,
     service text,
     body jsonb not null,
     created_at timestamptz not null default now(),
     primary key (tenant, id, version)
   )`,
  ...tenantIsolation('eval_test_sets'),
  `create or replace trigger eval_test_sets_append_only before update or delete on eval_test_sets
     for each row execute function refuse_change()`,
  `create table if not exists eval_runs (
     id text primary key,
     tenant text not null,
     task text not null,
     service text,
     subject text,
     test_set text not null,
     ended_at text collate "C" not null,
     body jsonb not null
   )`,
  `create index if not exists eval_runs_tenant on eval_runs (tenant, ended_at desc)`,
  ...tenantIsolation('eval_runs'),
  `create or replace function find_eval_run(p_id text) returns setof eval_runs
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from eval_runs where id = p_id;
     end $$`,
  `create table if not exists eval_feedback (
     seq bigint generated always as identity primary key,
     tenant text not null,
     task text not null,
     rating text not null,
     at text collate "C" not null,
     body bytea not null
   )`,
  `create index if not exists eval_feedback_tenant on eval_feedback (tenant, at desc)`,
  ...tenantIsolation('eval_feedback'),
  `create or replace trigger eval_feedback_append_only before update or delete on eval_feedback
     for each row execute function refuse_change()`,
  `create table if not exists eval_candidates (
     id text primary key,
     tenant text not null,
     status text not null,
     proposed_at text collate "C" not null,
     body bytea not null
   )`,
  `create index if not exists eval_candidates_tenant on eval_candidates (tenant, proposed_at desc)`,
  ...tenantIsolation('eval_candidates'),
  `create or replace function find_eval_candidate(p_id text) returns setof eval_candidates
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from eval_candidates where id = p_id;
     end $$`,
  `create table if not exists judge_labels (
     seq bigint generated always as identity primary key,
     judge text not null,
     label jsonb not null
   )`,
  `create or replace trigger judge_labels_append_only before update or delete on judge_labels
     for each row execute function refuse_change()`,
  `alter table legacy_api_keys add column if not exists service text`,
  `alter table legacy_api_keys add column if not exists allowed_overrides text[]`,
  `alter table legacy_api_keys add column if not exists calls_per_minute int`,
  `alter table legacy_api_keys add column if not exists skill_graph_grants text[] not null default '{}'`,
  `alter table legacy_api_keys add column if not exists allowed_config_keys text[] not null default '{}'`,
  `alter table legacy_api_keys add column if not exists policy_id text`,
  `create table if not exists api_key_policies (
     id text primary key,
     tenant char(9) not null,
     name text not null,
     scopes text[] not null default '{}',
     dataset_grants text[] not null default '{}',
     agent_grants text[] not null default '{}',
     skill_graph_grants text[] not null default '{}',
     allowed_config_keys text[] not null default '{}',
     created_at timestamptz not null default now()
   )`,
  ...tenantIsolation('api_key_policies'),
  `create or replace function find_api_key_policy(p_id text) returns setof api_key_policies
     language plpgsql security definer set search_path = public
     as $$
     declare previous text := current_setting('app.platform_access', true);
     begin
       perform set_config('app.platform_access', 'api-key-policy', true);
       return query select * from api_key_policies where id = p_id;
       perform set_config('app.platform_access', coalesce(previous, ''), true);
     end $$`,
  `create table if not exists rate_limit_windows (
     bucket text primary key,
     hits bigint[] not null default '{}',
     updated_at timestamptz not null default now()
   )`,
  `create or replace function take_rate_limit(p_bucket text, p_window_ms bigint, p_max integer)
     returns bigint language plpgsql set search_path = public
     as $$
     declare
       at bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
       kept bigint[];
     begin
       insert into rate_limit_windows (bucket) values (p_bucket) on conflict (bucket) do nothing;
       select coalesce(array(select h from unnest(r.hits) h where h > at - p_window_ms order by h), '{}')
         into kept from rate_limit_windows r where r.bucket = p_bucket for update;
       if cardinality(kept) >= p_max then
         update rate_limit_windows set hits = kept, updated_at = now() where bucket = p_bucket;
         return greatest(1, kept[cardinality(kept) - p_max + 1] + p_window_ms - at);
       end if;
       update rate_limit_windows set hits = kept || at, updated_at = now() where bucket = p_bucket;
       return 0;
     end $$`,
  `do $$ begin
     perform set_config('app.platform_access', 'api-key-all-grants', true);
     update legacy_api_keys set agent_grants = '{*}', dataset_grants = '{*}'
       where not legacy and service is null
         and cardinality(agent_grants) = 0 and cardinality(dataset_grants) = 0;
     perform set_config('app.platform_access', '', true);
   end $$`,
  `alter table legacy_api_keys alter column legacy set default false`,
  `do $$ begin
     perform set_config('app.platform_access', 'api-key-all-grants', true);
     update legacy_api_keys set agent_grants = '{*}', dataset_grants = '{*}'
       where legacy and service is null
         and cardinality(agent_grants) = 0 and cardinality(dataset_grants) = 0;
     update legacy_api_keys set legacy = false where legacy;
     perform set_config('app.platform_access', '', true);
   end $$`,
  `alter table legacy_api_keys add column if not exists admitted_in_lockdown boolean not null default false`,
  `create table if not exists clients (
     tenant text not null,
     id text not null,
     version integer not null,
     definition jsonb not null,
     updated_at timestamptz not null,
     updated_by text not null,
     primary key (tenant, id)
   )`,
  ...tenantIsolation('clients'),
  `create or replace function platform_clients() returns setof clients
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from clients order by tenant, id;
     end $$`,
  `create table if not exists webhook_deliveries (
     id text primary key,
     tenant text not null,
     client text not null,
     event text not null,
     at timestamptz not null,
     ok boolean not null,
     status integer,
     error text
   )`,
  `create index if not exists webhook_deliveries_recent on webhook_deliveries (tenant, client, at desc)`,
  ...tenantIsolation('webhook_deliveries'),
  `create table if not exists trigger_runs (
     id text primary key,
     tenant text not null,
     service text not null,
     trigger_id text not null,
     kind text not null,
     target text not null,
     task text,
     outcome text not null,
     error text,
     at timestamptz not null
   )`,
  `alter table trigger_runs add column if not exists code text`,
  `alter table trigger_runs add column if not exists input_tokens integer`,
  `alter table trigger_runs add column if not exists output_tokens integer`,
  `alter table trigger_runs add column if not exists cost_micro_nok bigint`,
  `create index if not exists trigger_runs_recent on trigger_runs (tenant, trigger_id, at desc)`,
  ...tenantIsolation('trigger_runs'),
  `create table if not exists config_entries (
     kind text not null,
     scope text not null,
     id text not null,
     version integer not null,
     spec jsonb not null,
     deleted boolean not null,
     by text not null,
     at text not null,
     reason text not null,
     primary key (kind, scope, id, version)
   )`,
  `create or replace trigger config_entries_append_only before update or delete on config_entries
     for each row execute function refuse_change()`,
  `create table if not exists change_versions (
     topic text primary key,
     version bigint not null
   )`,
  `create or replace function bump_change() returns trigger
     language plpgsql security definer set search_path = public
     as $$ begin
       insert into change_versions (topic, version) values (tg_argv[0], 1)
         on conflict (topic) do update set version = change_versions.version + 1;
       perform pg_notify('genai_changes', tg_argv[0]);
       return null;
     end $$`,
  ...(
    [
      ['setting_default_versions', 'settings'],
      ['setting_locks', 'settings'],
      ['tenant_settings', 'settings'],
      ['support_sessions', 'support-sessions'],
      ['config_entries', 'config-entries'],
      ['definition_versions', 'definitions'],
      ['model_classifications', 'model-classifications'],
      ['tool_connections', 'tool-connections'],
    ] as const
  ).map(
    ([table, topic]) =>
      `create or replace trigger ${table}_changed after insert or update or delete on ${table}
         for each statement execute function bump_change('${topic}')`,
  ),
  `revoke all on function bump_change() from public`,
  `alter table tenants add column if not exists status text not null default 'active'
     check (status in ('active', 'onboarding', 'paused'))`,
  `create or replace function platform_tenants() returns setof tenants
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from tenants order by org_number;
     end $$`,
  `create table if not exists ingestion_executions (
     id text primary key,
     scope text not null,
     dataset text not null,
     pipeline text not null,
     pipeline_version integer not null,
     backend text not null,
     status text not null check (status in ('running', 'succeeded', 'failed', 'cancelled')),
     started_by text not null,
     started_at text collate "C" not null,
     ended_at text,
     report jsonb,
     error text
   )`,
  `create index if not exists ingestion_executions_recent
     on ingestion_executions (scope, dataset, pipeline, started_at desc)`,
  `do $$
     declare existing text;
     begin
       select conname into existing from pg_constraint
        where conrelid = 'ingestion_executions'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%status%'
          and pg_get_constraintdef(oid) not like '%cancelled%';
       if existing is not null then
         execute format('alter table ingestion_executions drop constraint %I', existing);
         alter table ingestion_executions add constraint ingestion_executions_status_check
           check (status in ('running', 'succeeded', 'failed', 'cancelled'));
       end if;
     end $$`,
  ...tenantIsolation('ingestion_executions', 'scope'),
  `create or replace function find_ingestion_execution(p_id text) returns setof ingestion_executions
     language plpgsql stable security definer set search_path = public
     as $$ begin
       perform require_platform_access();
       return query select * from ingestion_executions where id = p_id;
     end $$`,
  `create or replace function fail_stale_ingestion_executions(
       p_started_before text, p_except text[], p_ended_at text, p_error text) returns integer
     language plpgsql volatile security definer set search_path = public
     as $$ declare changed integer; begin
       perform require_platform_access();
       update ingestion_executions set status = 'failed', ended_at = p_ended_at, error = p_error
         where status = 'running' and started_at < p_started_before and not (id = any(p_except));
       get diagnostics changed = row_count;
       return changed;
     end $$`,
  `create index if not exists tasks_tenant_recent on tasks (tenant, created_at desc)`,
  `create index if not exists tasks_recent on tasks (created_at desc)`,
  `alter table tenant_settings add column if not exists version bigint not null default 0`,
  ...Object.entries(publishedTables).flatMap(([table, column]) =>
    publishedIsolation(table, column),
  ),
  `do $$ begin
     create role ${runtimeRole} nologin nosuperuser nobypassrls;
   exception when duplicate_object then null;
   end $$`,
  `do $$ begin
     if exists (select from pg_roles where rolname = '${runtimeRole}' and (rolsuper or rolbypassrls)) then
       raise exception '${runtimeRole} must not be a superuser or bypass row-level security';
     end if;
     if current_setting('server_version_num')::int >= 160000 then
       if not pg_has_role(current_user, '${runtimeRole}', 'SET') then
         execute format('grant ${runtimeRole} to %I with set true', current_user);
       end if;
     elsif not pg_has_role(current_user, '${runtimeRole}', 'MEMBER') then
       execute format('grant ${runtimeRole} to %I', current_user);
     end if;
   end $$`,
  `grant select, insert, update, delete on ${[
    ...tenantTables,
    ...Object.keys(publishedTables),
    ...kernelTables,
    ...platformTables,
  ].join(', ')} to ${runtimeRole}`,
  `grant usage on schema public to ${runtimeRole}`,
  `grant usage, select on all sequences in schema public to ${runtimeRole}`,
  ...definerFunctions.map((fn) => `revoke all on function ${fn} from public`),
  `grant execute on function ${definerFunctions.join(', ')} to ${runtimeRole}`,
];

export const grantRuntimeRole = async (pool: Pool, role: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('invalid role name');
  await pool.query(`grant ${runtimeRole} to ${role}`);
};

export const migrate = async (pool: Pool) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-migrate'))`);
    for (const sql of migrations) await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
