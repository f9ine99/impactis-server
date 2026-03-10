/* Simple migration runner for local Postgres in Docker.
 *
 * Reads all SQL files in ../supabase/migrations and applies them in
 * filename order to the database pointed to by process.env.DATABASE_URL.
 */
require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Please configure it in impactis-server/.env.local.');
    process.exit(1);
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found at: ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found to apply.');
    return;
  }

  console.log(`Applying ${files.length} migrations to ${databaseUrl}...`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // Ensure migrations history table exists
    await client.query(`
      create table if not exists public._migrations (
        filename text primary key,
        applied_at timestamptz not null default timezone('utc', now())
      );
    `);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);

      // Skip if already recorded in _migrations
      const existing = await client.query(
        'select 1 from public._migrations where filename = $1 limit 1;',
        [file],
      );
      if (existing.rows.length > 0) {
        console.log(`\n--- Skipping already applied migration: ${file} ---`);
        continue;
      }

      // Special-case: if the core baseline objects already exist, just mark it as applied.
      if (file.startsWith('20260225000000_init_core_public_schema')) {
        const baselineCheck = await client.query(`
          select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'org_members'
          limit 1;
        `);

        if (baselineCheck.rows.length > 0) {
          console.log(
            `\n--- Baseline objects already present; marking migration as applied without re-running: ${file} ---`,
          );
          await client.query(
            'insert into public._migrations (filename) values ($1) on conflict (filename) do nothing;',
            [file],
          );
          continue;
        }
      }

      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`\n--- Applying migration: ${file} ---`);
      await client.query(sql);
      await client.query(
        'insert into public._migrations (filename) values ($1) on conflict (filename) do nothing;',
        [file],
      );
      console.log(`Migration applied: ${file}`);
    }

    console.log('\nAll migrations applied successfully.');
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('Unexpected migration runner error:', error);
  process.exit(1);
});

