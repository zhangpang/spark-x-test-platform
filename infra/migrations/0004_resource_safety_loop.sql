create table if not exists resource_locks (
  id uuid primary key,
  lock_key text not null check (char_length(lock_key) between 1 and 256),
  run_id uuid not null references test_runs (id) on delete cascade,
  run_case_id uuid not null references test_run_cases (id) on delete cascade,
  leased_until timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  acquired_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text check (
    release_reason is null or
    release_reason in ('cleaned', 'no_side_effect', 'cancelled', 'compensation_succeeded', 'expired')
  )
);

create unique index if not exists resource_locks_active_key_idx
  on resource_locks (lock_key) where released_at is null;
create index if not exists resource_locks_run_active_idx
  on resource_locks (run_id, run_case_id) where released_at is null;
create index if not exists resource_locks_lease_idx
  on resource_locks (leased_until) where released_at is null;

create table if not exists cleanup_jobs (
  id uuid primary key,
  run_id uuid not null unique references test_runs (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  outcome_summary jsonb not null check (jsonb_typeof(outcome_summary) = 'object'),
  gate_result text not null check (gate_result in ('passed', 'blocked', 'inconclusive')),
  first_failure jsonb check (first_failure is null or jsonb_typeof(first_failure) = 'object'),
  last_error jsonb check (last_error is null or jsonb_typeof(last_error) = 'object'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists cleanup_jobs_status_created_idx
  on cleanup_jobs (status, created_at);
