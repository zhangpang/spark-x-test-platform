create table if not exists test_runs (
  id uuid primary key,
  sequence_number bigserial unique,
  trigger_type text not null check (trigger_type in ('manual', 'schedule', 'release', 'api')),
  trigger_source text not null check (char_length(trigger_source) between 1 and 200),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  priority integer not null default 50 check (priority between 1 and 100),
  system_id uuid not null references systems (id),
  environment_id uuid not null references environments (id),
  suite_id uuid not null references test_suites (id),
  tested_version text not null default '' check (char_length(tested_version) <= 200),
  platform_version text not null check (char_length(platform_version) between 1 and 100),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'preparing', 'running', 'cancelling', 'cleaning',
                      'interrupted', 'compensation_pending', 'completed')),
  gate_result text check (gate_result in ('passed', 'blocked', 'inconclusive')),
  summary jsonb not null default
    '{"total":0,"queued":0,"running":0,"passed":0,"productFailed":0,"testFailed":0,"environmentFailed":0,"infrastructureFailed":0,"flaky":0,"cancelled":0,"skipped":0}'::jsonb
    check (jsonb_typeof(summary) = 'object'),
  cancellation_requested boolean not null default false,
  first_failure jsonb check (first_failure is null or jsonb_typeof(first_failure) = 'object'),
  worker_id text,
  worker_image_digest text,
  executor_version text,
  worker_heartbeat_at timestamptz,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (trigger_source, system_id, idempotency_key)
);

create index if not exists test_runs_system_status_queued_idx
  on test_runs (system_id, status, queued_at desc);
create index if not exists test_runs_environment_status_idx
  on test_runs (environment_id, status, queued_at);

create table if not exists test_run_cases (
  id uuid primary key,
  run_id uuid not null references test_runs (id) on delete cascade,
  case_id uuid not null references test_cases (id),
  case_version_id uuid not null references test_case_versions (id),
  iteration integer not null default 1 check (iteration between 1 and 100),
  sort_order integer not null check (sort_order >= 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'cleaning', 'completed')),
  result text check (result in ('passed', 'product_failed', 'test_failed', 'environment_failed',
                                'infrastructure_failed', 'flaky', 'cancelled', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  flaky boolean not null default false,
  first_failure jsonb check (first_failure is null or jsonb_typeof(first_failure) = 'object'),
  cleanup_status text not null default 'pending'
    check (cleanup_status in ('pending', 'not_required', 'running', 'passed', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  unique (run_id, case_id, case_version_id, iteration)
);

create index if not exists test_run_cases_run_sort_idx
  on test_run_cases (run_id, sort_order, iteration);

create table if not exists step_runs (
  id uuid primary key,
  run_case_id uuid not null references test_run_cases (id) on delete cascade,
  attempt integer not null check (attempt between 1 and 100),
  step_path text not null check (char_length(step_path) between 1 and 500),
  step_id text not null check (char_length(step_id) between 1 and 200),
  action text not null check (char_length(action) between 1 and 200),
  phase text not null check (phase in ('main', 'finally')),
  status text not null check (status in ('running', 'passed', 'failed', 'cancelled')),
  result text check (result in ('passed', 'product_failed', 'test_failed', 'environment_failed',
                                'infrastructure_failed', 'flaky', 'cancelled', 'skipped')),
  input_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(input_summary) = 'object'),
  output_summary jsonb check (output_summary is null or jsonb_typeof(output_summary) = 'object'),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  unique (run_case_id, attempt, step_path)
);

create index if not exists step_runs_case_attempt_idx
  on step_runs (run_case_id, attempt, started_at);

create table if not exists run_events (
  id bigserial primary key,
  run_id uuid not null references test_runs (id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 100),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists run_events_run_id_id_idx on run_events (run_id, id);

create table if not exists artifacts (
  id uuid primary key,
  run_id uuid not null references test_runs (id) on delete cascade,
  run_case_id uuid references test_run_cases (id) on delete cascade,
  step_run_id uuid references step_runs (id) on delete cascade,
  kind text not null check (kind in ('log', 'screenshot', 'trace', 'http_exchange', 'tool_call',
                                     'matched_document', 'judge', 'external_report')),
  object_key text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  redacted boolean not null default true,
  locked boolean not null default false,
  retained_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists resource_ledger (
  id uuid primary key,
  run_id uuid not null references test_runs (id) on delete cascade,
  run_case_id uuid not null references test_run_cases (id) on delete cascade,
  resource_type text not null,
  system_resource_id text not null,
  created_step_run_id uuid references step_runs (id),
  cleanup_definition jsonb not null check (jsonb_typeof(cleanup_definition) = 'object'),
  cleanup_status text not null default 'pending'
    check (cleanup_status in ('pending', 'running', 'passed', 'failed')),
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, resource_type, system_resource_id)
);

create table if not exists workers (
  id text primary key,
  identity text,
  image_digest text not null,
  executor_version text not null,
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  concurrency_slots integer not null check (concurrency_slots between 1 and 100),
  active_slots integer not null default 0 check (active_slots between 0 and 100),
  status text not null default 'online' check (status in ('online', 'draining', 'offline')),
  last_seen_at timestamptz not null default now()
);
