import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createPlatformDependencies, loadPlatformConfig } from "@spark-x-test/service-runtime";

const migrationsDirectory = resolve("infra/migrations");
const lockId = 7_143_110_527;
const config = loadPlatformConfig();
const dependencies = createPlatformDependencies(config);
const client = await dependencies.postgres.connect();

try {
  await client.query("select pg_advisory_lock($1)", [lockId]);
  await client.query(`
    create table if not exists platform_schema_migrations (
      version text primary key,
      checksum_sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/.test(filename))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum_sha256: string }>(
      "select checksum_sha256 from platform_schema_migrations where version = $1",
      [filename],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]?.checksum_sha256 !== checksum) {
        throw new Error(`Committed migration changed after application: ${filename}`);
      }
      console.info(`migration already applied: ${filename}`);
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into platform_schema_migrations (version, checksum_sha256) values ($1, $2)",
        [filename, checksum],
      );
      await client.query("commit");
      console.info(`migration applied: ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.query("select pg_advisory_unlock($1)", [lockId]).catch(() => undefined);
  client.release();
  await dependencies.close();
}
