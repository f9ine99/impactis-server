import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

type QueryResult = 'ok' | 'error';

type QueryTelemetryInput = {
  queryText: string;
  durationMs: number;
  rowCount?: number | null;
  result: QueryResult;
};

type QueryAggregate = {
  queryFamily: string;
  queryHash: string;
  result: QueryResult;
  calls: number;
  totalMs: number;
  maxMs: number;
  slowCalls: number;
  rowsTotal: number;
};

@Injectable()
export class DbQueryTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DbQueryTelemetry');
  private readonly enabled: boolean;
  private readonly flushIntervalMs: number;
  private readonly slowQueryThresholdMs: number;
  private readonly aggregates = new Map<string, QueryAggregate>();
  private windowStartedAtMs = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.parseBoolean(
      this.config.get<boolean>('dbQueryTelemetryEnabled'),
      this.parseBooleanFromEnv(process.env.DB_QUERY_TELEMETRY_ENABLED, false),
    );
    this.flushIntervalMs = this.parsePositiveInt(
      this.config.get<number>('dbQueryTelemetryFlushIntervalMs'),
      this.parsePositiveIntFromEnv(process.env.DB_QUERY_TELEMETRY_FLUSH_INTERVAL_MS, 60000),
    );
    this.slowQueryThresholdMs = this.parsePositiveInt(
      this.config.get<number>('dbSlowQueryThresholdMs'),
      this.parsePositiveIntFromEnv(process.env.DB_SLOW_QUERY_THRESHOLD_MS, 120),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.windowStartedAtMs = Date.now();
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.flush();
  }

  recordQuery(input: QueryTelemetryInput): void {
    if (!this.enabled) {
      return;
    }

    const normalizedSql = this.normalizeSqlForHash(input.queryText);
    if (!normalizedSql) {
      return;
    }

    const durationMs = this.normalizeDurationMs(input.durationMs);
    const rowCount = this.normalizeRowCount(input.rowCount);
    const queryHash = this.hashQuery(normalizedSql);
    const queryFamily = this.resolveQueryFamily(normalizedSql);
    const key = `${queryFamily}|${queryHash}|${input.result}`;

    const aggregate = this.aggregates.get(key) ?? {
      queryFamily,
      queryHash,
      result: input.result,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      slowCalls: 0,
      rowsTotal: 0,
    };

    aggregate.calls += 1;
    aggregate.totalMs += durationMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
    aggregate.rowsTotal += rowCount;

    const isSlow = durationMs >= this.slowQueryThresholdMs;
    if (isSlow) {
      aggregate.slowCalls += 1;
      this.logger.warn(JSON.stringify({
        event: 'db_query_slow',
        query_family: queryFamily,
        query_hash: queryHash,
        result: input.result,
        duration_ms: durationMs,
        row_count: rowCount,
        threshold_ms: this.slowQueryThresholdMs,
      }));
    }

    this.aggregates.set(key, aggregate);
  }

  flush(): void {
    if (!this.enabled) {
      return;
    }

    const windowEndedAtMs = Date.now();
    const windowMs = Math.max(0, windowEndedAtMs - this.windowStartedAtMs);
    if (this.aggregates.size < 1) {
      this.windowStartedAtMs = windowEndedAtMs;
      return;
    }

    const counters = Array.from(this.aggregates.values())
      .sort((left, right) => {
        const keyLeft = `${left.queryFamily}|${left.queryHash}|${left.result}`;
        const keyRight = `${right.queryFamily}|${right.queryHash}|${right.result}`;
        return keyLeft.localeCompare(keyRight);
      })
      .map((entry) => ({
        query_family: entry.queryFamily,
        query_hash: entry.queryHash,
        result: entry.result,
        calls: entry.calls,
        total_ms: this.roundMetric(entry.totalMs),
        max_ms: this.roundMetric(entry.maxMs),
        slow_calls: entry.slowCalls,
        rows_total: entry.rowsTotal,
      }));

    this.logger.log(JSON.stringify({
      event: 'db_query_telemetry_rollup',
      window_ms: windowMs,
      window_started_at: new Date(this.windowStartedAtMs).toISOString(),
      window_ended_at: new Date(windowEndedAtMs).toISOString(),
      counters,
    }));

    this.aggregates.clear();
    this.windowStartedAtMs = windowEndedAtMs;
  }

  private parseBoolean(value: boolean | null | undefined, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    return fallback;
  }

  private parseBooleanFromEnv(value: string | undefined, fallback: boolean): boolean {
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }

    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }

    return fallback;
  }

  private parsePositiveInt(value: number | null | undefined, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.trunc(value);
    }

    return fallback;
  }

  private parsePositiveIntFromEnv(value: string | undefined, fallback: number): number {
    if (typeof value !== 'string') {
      return fallback;
    }

    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }

    return fallback;
  }

  private normalizeDurationMs(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.max(0, value);
  }

  private normalizeRowCount(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    return Math.max(0, Math.trunc(value));
  }

  private roundMetric(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.round(value * 1000) / 1000;
  }

  private hashQuery(normalizedSql: string): string {
    return createHash('sha256').update(normalizedSql).digest('hex').slice(0, 16);
  }

  private normalizeSqlForHash(rawSql: string): string {
    const withoutBlockComments = rawSql.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const withoutLineComments = withoutBlockComments.replace(/--.*$/gm, ' ');
    const withoutQuotedLiterals = withoutLineComments.replace(/'(?:''|[^'])*'/g, '?');
    const withoutNumericLiterals = withoutQuotedLiterals.replace(/\b\d+(?:\.\d+)?\b/g, '?');
    const collapsed = withoutNumericLiterals.replace(/\s+/g, ' ').trim().toLowerCase();
    return collapsed;
  }

  private resolveQueryFamily(normalizedSql: string): string {
    const leadingVerbMatch = normalizedSql.match(/^([a-z]+)/);
    const leadingVerb = leadingVerbMatch?.[1] ?? 'unknown';
    const effectiveVerb = leadingVerb === 'with'
      ? (normalizedSql.match(/\b(select|insert|update|delete)\b/)?.[1] ?? 'with')
      : leadingVerb;
    const tableToken = this.extractPublicTableToken(normalizedSql)
      ?? this.extractTableToken(normalizedSql, effectiveVerb);
    return `${effectiveVerb}:${tableToken ?? 'unknown'}`;
  }

  private extractPublicTableToken(normalizedSql: string): string | null {
    const match = normalizedSql.match(/\b(?:from|join|into|update)\s+(public\.[a-z0-9_."-]+)/);
    const rawTable = match?.[1]?.trim();
    if (!rawTable) {
      return null;
    }

    const sanitized = rawTable.replace(/"/g, '');
    return sanitized.length > 0 ? sanitized : null;
  }

  private extractTableToken(normalizedSql: string, effectiveVerb: string): string | null {
    let match: RegExpMatchArray | null = null;
    if (effectiveVerb === 'insert') {
      match = normalizedSql.match(/\binto\s+([a-z0-9_."-]+)/);
    } else if (effectiveVerb === 'update') {
      match = normalizedSql.match(/\bupdate\s+([a-z0-9_."-]+)/);
    } else if (effectiveVerb === 'select' || effectiveVerb === 'delete') {
      match = normalizedSql.match(/\bfrom\s+([a-z0-9_."-]+)/);
    }

    const rawTable = match?.[1]?.trim();
    if (!rawTable) {
      return null;
    }

    const sanitized = rawTable.replace(/"/g, '');
    return sanitized.length > 0 ? sanitized : null;
  }
}
