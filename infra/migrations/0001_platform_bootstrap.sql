create table if not exists platform_schema_migrations (
  version text primary key,
  checksum_sha256 text not null,
  applied_at timestamptz not null default now()
);

create table if not exists service_heartbeats (
  service_name text not null check (service_name in ('api', 'scheduler', 'worker')),
  instance_id text not null,
  platform_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null,
  primary key (service_name, instance_id)
);

create index if not exists service_heartbeats_last_seen_at_idx
  on service_heartbeats (last_seen_at desc);
