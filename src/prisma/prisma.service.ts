import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { DbQueryTelemetryService } from './db-query-telemetry.service';

function compileTaggedSql(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): { text: string; values: unknown[] } {
  let text = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    text += `$${i + 1}${strings[i + 1] ?? ''}`;
  }

  return { text, values: [...values] };
}

export interface PrismaSqlExecutor {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | string,
    ...values: readonly unknown[]
  ): Promise<T>;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly queryTagPrefix: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queryTelemetry: DbQueryTelemetryService,
  ) {
    const databaseUrl = this.config.get<string>('databaseUrl') ?? process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not configured.');
    }

    if (
      databaseUrl.includes('YOUR_PROJECT_ID')
      || databaseUrl.includes('YOUR_PASSWORD')
      || databaseUrl.includes('impactis.local')
    ) {
      throw new Error(
        'DATABASE_URL is still using placeholder values. Update server/.env.local with a real Postgres URL.',
      );
    }

    const applicationName = this.normalizeIdentifier(
      this.config.get<string>('dbApplicationName') ?? process.env.DB_APPLICATION_NAME,
      'impactis_api',
    );
    const queryTag = this.normalizeIdentifier(
      this.config.get<string>('dbQueryTag') ?? process.env.DB_QUERY_TAG,
      'impactis_api',
    );
    this.queryTagPrefix = `/* app=${queryTag} */`;

    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: applicationName,
    });
  }

  async onModuleInit() {
    try {
      await this.pool.query('select 1');
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && error.code === 'ENETUNREACH'
      ) {
        throw new Error(
          'Database network route is unreachable. If you are using Supabase direct host (db.<project>.supabase.co), switch DATABASE_URL to the Supabase pooler host (aws-1-<region>.pooler.supabase.com) or enable IPv6 on your network.',
        );
      }

      throw error;
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async enableShutdownHooks(_app: INestApplication) {
    // No-op: `pg` pool is closed in `onModuleDestroy`.
  }

  private compileQuery(
    query: TemplateStringsArray | string,
    values: readonly unknown[],
  ): { text: string; values: unknown[] } {
    return typeof query === 'string' ? { text: query, values: [...values] } : compileTaggedSql(query, values);
  }

  private async runCompiledQuery<T>(
    client: PoolClient | Pool,
    query: TemplateStringsArray | string,
    values: readonly unknown[],
  ): Promise<T> {
    const compiled = this.compileQuery(query, values);
    const taggedQuery = this.tagQuery(compiled.text);
    const startedAt = process.hrtime.bigint();

    try {
      const result = await client.query(taggedQuery, compiled.values as unknown[]);
      this.queryTelemetry.recordQuery({
        queryText: taggedQuery,
        durationMs: this.getDurationMs(startedAt),
        rowCount: this.resolveRowCount(result.rowCount, result.rows),
        result: 'ok',
      });
      return result.rows as T;
    } catch (error) {
      this.queryTelemetry.recordQuery({
        queryText: taggedQuery,
        durationMs: this.getDurationMs(startedAt),
        rowCount: 0,
        result: 'error',
      });
      throw error;
    }
  }

  async $queryRaw<T = unknown>(
    query: TemplateStringsArray | string,
    ...values: readonly unknown[]
  ): Promise<T> {
    return this.runCompiledQuery<T>(this.pool, query, values);
  }

  async $transaction<T>(callback: (tx: PrismaSqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: PrismaSqlExecutor = {
      $queryRaw: <R>(
        query: TemplateStringsArray | string,
        ...values: readonly unknown[]
      ): Promise<R> => this.runCompiledQuery<R>(client, query, values),
    };

    try {
      await client.query('begin');
      const result = await callback(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // Ignore rollback errors and surface the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private normalizeIdentifier(value: string | undefined, fallback: string): string {
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_');
    return normalized.length > 0 ? normalized : fallback;
  }

  private tagQuery(queryText: string): string {
    const trimmed = queryText.trim();
    if (trimmed.length < 1) {
      return queryText;
    }

    if (/^\/\*\s*app=/i.test(trimmed)) {
      return queryText;
    }

    return `${this.queryTagPrefix} ${queryText}`;
  }

  private getDurationMs(startedAt: bigint): number {
    const elapsedNs = process.hrtime.bigint() - startedAt;
    return Number(elapsedNs) / 1_000_000;
  }

  private resolveRowCount(rowCount: number | null, rows: unknown[]): number {
    if (typeof rowCount === 'number' && Number.isFinite(rowCount)) {
      return Math.max(0, Math.trunc(rowCount));
    }

    return Array.isArray(rows) ? rows.length : 0;
  }
}
