create table if not exists systems (
  id uuid primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 4000),
  status text not null default 'active' check (status in ('active', 'archived')),
  concurrency_limit integer not null default 5 check (concurrency_limit between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists modules (
  id uuid primary key,
  system_id uuid not null references systems (id),
  key text not null check (key ~ '^[a-z][a-z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 200),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (system_id, key)
);

create index if not exists modules_system_sort_idx
  on modules (system_id, sort_order, created_at);

create table if not exists environments (
  id uuid primary key,
  system_id uuid not null references systems (id),
  key text not null check (key ~ '^[a-z][a-z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 200),
  kind text not null check (kind in ('test', 'staging', 'production')),
  base_url text not null,
  action_level text not null check (action_level in ('read', 'write', 'dangerous')),
  allowlist jsonb not null check (jsonb_typeof(allowlist) = 'array' and jsonb_array_length(allowlist) > 0),
  timezone text not null default 'Asia/Shanghai',
  concurrency_limit integer not null default 5 check (concurrency_limit between 1 and 100),
  adapter_key text,
  adapter_config jsonb not null default '{}'::jsonb check (jsonb_typeof(adapter_config) = 'object'),
  status text not null default 'active' check (status in ('active', 'disabled', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_id, key),
  check (kind <> 'production' or action_level = 'read')
);

create index if not exists environments_system_status_idx
  on environments (system_id, status, created_at);

create table if not exists secrets (
  id uuid primary key,
  system_id uuid not null references systems (id),
  environment_id uuid references environments (id),
  key text not null check (key ~ '^[a-z][a-z0-9_.-]*$'),
  encrypted_value bytea not null,
  encryption_iv bytea not null check (octet_length(encryption_iv) = 12),
  authentication_tag bytea not null check (octet_length(authentication_tag) = 16),
  version integer not null default 1 check (version >= 1),
  rotated_at timestamptz not null default now(),
  unique nulls not distinct (system_id, environment_id, key)
);

create index if not exists secrets_scope_idx
  on secrets (system_id, environment_id, key);

create table if not exists test_cases (
  id uuid primary key,
  module_id uuid not null references modules (id),
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'draft' check (status in ('draft', 'published', 'disabled', 'archived')),
  current_draft_version_id uuid,
  current_published_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists test_cases_module_status_idx
  on test_cases (module_id, status, updated_at desc);

create table if not exists test_case_versions (
  id uuid primary key,
  case_id uuid not null references test_cases (id),
  version integer not null check (version >= 1),
  schema_version text not null,
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  change_note text not null default '' check (char_length(change_note) <= 1000),
  validation_result jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (case_id, version)
);

alter table test_cases
  add constraint test_cases_current_draft_version_fk
  foreign key (current_draft_version_id) references test_case_versions (id);

alter table test_cases
  add constraint test_cases_current_published_version_fk
  foreign key (current_published_version_id) references test_case_versions (id);

create index if not exists test_case_versions_case_version_idx
  on test_case_versions (case_id, version desc);

create table if not exists shared_steps (
  id uuid primary key,
  system_id uuid not null references systems (id),
  name text not null check (char_length(name) between 1 and 200),
  current_draft_version_id uuid,
  current_published_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists shared_step_versions (
  id uuid primary key,
  shared_step_id uuid not null references shared_steps (id),
  version integer not null check (version >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  change_note text not null default '' check (char_length(change_note) <= 1000),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shared_step_id, version)
);

alter table shared_steps
  add constraint shared_steps_current_draft_version_fk
  foreign key (current_draft_version_id) references shared_step_versions (id);

alter table shared_steps
  add constraint shared_steps_current_published_version_fk
  foreign key (current_published_version_id) references shared_step_versions (id);

create table if not exists datasets (
  id uuid primary key,
  system_id uuid not null references systems (id),
  name text not null check (char_length(name) between 1 and 200),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists dataset_versions (
  id uuid primary key,
  dataset_id uuid not null references datasets (id),
  version integer not null check (version >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  change_note text not null default '' check (char_length(change_note) <= 1000),
  created_at timestamptz not null default now(),
  unique (dataset_id, version)
);

alter table datasets
  add constraint datasets_current_version_fk
  foreign key (current_version_id) references dataset_versions (id);

create table if not exists test_suites (
  id uuid primary key,
  system_id uuid not null references systems (id),
  key text not null check (key ~ '^[a-z][a-z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 4000),
  default_concurrency integer not null default 1 check (default_concurrency between 1 and 100),
  default_diagnostic_retries integer not null default 0 check (default_diagnostic_retries between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_id, key)
);

create table if not exists suite_cases (
  suite_id uuid not null references test_suites (id) on delete cascade,
  case_id uuid not null references test_cases (id),
  sort_order integer not null check (sort_order >= 0),
  primary key (suite_id, case_id),
  unique (suite_id, sort_order)
);

create table if not exists case_templates (
  id uuid primary key,
  system_id uuid references systems (id),
  key text not null,
  name text not null check (char_length(name) between 1 and 200),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_at timestamptz not null default now(),
  unique nulls not distinct (system_id, key)
);

insert into case_templates (id, system_id, key, name, definition)
values (
  '00000000-0000-4000-8000-000000000201',
  null,
  'http-business-check',
  'HTTP 业务接口',
  '{"action":"http:request","fields":["method","path","expectedStatus","secretRef"],"targetSource":"environment","requiresRelativePath":true}'::jsonb
)
on conflict (system_id, key) do nothing;

create table if not exists operation_audits (
  id uuid primary key,
  occurred_at timestamptz not null default now(),
  source_ip text,
  request_id text not null,
  entrypoint text not null,
  actor text not null default 'anonymous',
  object_type text not null,
  object_id uuid,
  action text not null,
  before_version integer,
  after_version integer,
  result text not null check (result in ('succeeded', 'rejected', 'failed')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index if not exists operation_audits_occurred_at_idx
  on operation_audits (occurred_at desc);
