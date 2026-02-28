import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type UpstashResponse<T> = {
  result?: T;
  error?: string;
};

type LocalCacheEntry = {
  rawJson: string;
  expiresAt: number;
};

@Injectable()
export class UpstashRedisCacheService {
  private readonly logger = new Logger(UpstashRedisCacheService.name);
  private readonly restUrl: string | null;
  private readonly restToken: string | null;
  private readonly keyPrefix: string;
  private readonly localCacheTtlSeconds: number;
  private readonly localCacheMaxEntries: number;
  private readonly requestTimeoutMs: number;
  private readonly requestFailureCooldownMs: number;
  private readonly requestFailureCooldownMaxMs: number;
  private readonly localCache = new Map<string, LocalCacheEntry>();
  private remoteBypassUntilEpochMs = 0;
  private consecutiveRemoteFailures = 0;
  private hasWarnedDisabled = false;

  constructor(private readonly config: ConfigService) {
    this.restUrl = this.normalizeUrl(
      this.config.get<string>('upstashRedisRestUrl')
      ?? process.env.UPSTASH_REDIS_REST_URL,
    );
    this.restToken = this.normalizeText(
      this.config.get<string>('upstashRedisRestToken')
      ?? process.env.UPSTASH_REDIS_REST_TOKEN,
    );
    this.keyPrefix =
      this.normalizeText(
        this.config.get<string>('cacheKeyPrefix')
        ?? process.env.CACHE_KEY_PREFIX,
      )
      ?? 'impactis';
    this.localCacheTtlSeconds = this.parsePositiveInt(
      this.config.get<number>('cacheL1TtlSeconds'),
      this.parsePositiveIntFromEnv(process.env.CACHE_L1_TTL_SECONDS, 60),
    );
    this.localCacheMaxEntries = this.parsePositiveInt(
      this.config.get<number>('cacheL1MaxEntries'),
      this.parsePositiveIntFromEnv(process.env.CACHE_L1_MAX_ENTRIES, 2000),
    );
    this.requestTimeoutMs = this.parsePositiveInt(
      this.config.get<number>('cacheUpstashRequestTimeoutMs'),
      this.parsePositiveIntFromEnv(process.env.CACHE_UPSTASH_REQUEST_TIMEOUT_MS, 700),
    );
    this.requestFailureCooldownMs = this.parsePositiveInt(
      this.config.get<number>('cacheUpstashFailureCooldownMs'),
      this.parsePositiveIntFromEnv(process.env.CACHE_UPSTASH_FAILURE_COOLDOWN_MS, 5000),
    );
    this.requestFailureCooldownMaxMs = this.parsePositiveInt(
      this.config.get<number>('cacheUpstashFailureCooldownMaxMs'),
      this.parsePositiveIntFromEnv(process.env.CACHE_UPSTASH_FAILURE_COOLDOWN_MAX_MS, 60000),
    );
  }

  workspaceBootstrapKey(userId: string): string {
    return `workspace:bootstrap:v1:user:${userId}`;
  }

  workspaceIdentityKey(userId: string): string {
    return `workspace:identity:v1:user:${userId}`;
  }

  workspaceSettingsSnapshotKey(userId: string, section?: string | null): string {
    const normalizedSection = this.normalizeText(section)?.toLowerCase() ?? '_default';
    return `workspace:settings-snapshot:v1:user:${userId}:section:${normalizedSection}`;
  }

  workspaceSettingsSnapshotKeysForUser(userId: string): string[] {
    const sections = [
      null,
      'settings-identity',
      'settings-billing',
      'settings-startup-readiness',
      'settings-discovery',
      'settings-invites',
      'settings-permissions',
      'settings-team-access',
      'settings-readiness-rules',
    ];

    return sections.map((section) => this.workspaceSettingsSnapshotKey(userId, section));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const normalizedKey = this.normalizeText(key);
    if (!normalizedKey) {
      return null;
    }
    const prefixedKey = this.prefixedKey(normalizedKey);

    const cachedRawJson = this.readLocalCache(prefixedKey);
    if (cachedRawJson !== null) {
      const parsed = this.parseJson<T>(cachedRawJson);
      if (parsed !== null) {
        return parsed;
      }

      this.deleteLocalCache(prefixedKey);
    }

    if (!this.isEnabled()) {
      this.warnDisabledIfNeeded();
      return null;
    }

    const payload = await this.requestCommand<string | null>([
      'GET',
      prefixedKey,
    ]);
    if (payload === null || payload === undefined) {
      return null;
    }

    if (typeof payload !== 'string') {
      return payload as T;
    }

    if (payload.length < 1) {
      return null;
    }

    this.writeLocalCache(prefixedKey, payload);
    return this.parseJson<T>(payload);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const normalizedKey = this.normalizeText(key);
    if (!normalizedKey) {
      return;
    }

    const safeTtl = Number.isFinite(ttlSeconds)
      ? Math.max(1, Math.trunc(ttlSeconds))
      : 20;
    const valueJson = JSON.stringify(value ?? null);
    const prefixedKey = this.prefixedKey(normalizedKey);
    this.writeLocalCache(prefixedKey, valueJson, safeTtl);

    if (!this.isEnabled()) {
      this.warnDisabledIfNeeded();
      return;
    }
    void this.requestCommand<string>([
      'SET',
      prefixedKey,
      valueJson,
      'EX',
      safeTtl.toString(),
    ]);
  }

  async delete(key: string): Promise<void> {
    const normalizedKey = this.normalizeText(key);
    if (!normalizedKey) {
      return;
    }
    const prefixedKey = this.prefixedKey(normalizedKey);
    this.deleteLocalCache(prefixedKey);

    if (!this.isEnabled()) {
      this.warnDisabledIfNeeded();
      return;
    }

    void this.requestCommand<number | string>([
      'DEL',
      prefixedKey,
    ]);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.length < 1) {
      return;
    }

    const deduped = Array.from(
      new Set(
        keys
          .map((key) => this.normalizeText(key))
          .filter((key): key is string => !!key),
      ),
    );
    if (deduped.length < 1) {
      return;
    }

    const prefixedKeys = deduped.map((key) => this.prefixedKey(key));
    for (const key of prefixedKeys) {
      this.deleteLocalCache(key);
    }

    if (!this.isEnabled()) {
      this.warnDisabledIfNeeded();
      return;
    }

    void this.requestCommand<number | string>(['DEL', ...prefixedKeys]);
  }

  cacheFillLockKey(cacheKey: string): string {
    const normalized = this.normalizeText(cacheKey);
    if (!normalized) {
      return 'cache-fill-lock:invalid';
    }

    return `${normalized}:fill-lock`;
  }

  async tryAcquireLock(lockKey: string, ttlSeconds: number): Promise<boolean> {
    const normalizedKey = this.normalizeText(lockKey);
    if (!normalizedKey || !this.isEnabled()) {
      this.warnDisabledIfNeeded();
      return false;
    }

    const safeTtl = Number.isFinite(ttlSeconds)
      ? Math.max(1, Math.trunc(ttlSeconds))
      : 5;
    const result = await this.requestCommand<string | null>([
      'SET',
      this.prefixedKey(normalizedKey),
      '1',
      'NX',
      'EX',
      safeTtl.toString(),
    ]);

    return result === 'OK';
  }

  isRemoteCacheEnabled(): boolean {
    return this.isEnabled() && !this.isRemoteTemporarilyBypassed();
  }

  private isRemoteTemporarilyBypassed(): boolean {
    return this.remoteBypassUntilEpochMs > Date.now();
  }

  private normalizeText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeUrl(value: string | null | undefined): string | null {
    const trimmed = this.normalizeText(value);
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  }

  private isEnabled(): boolean {
    return !!this.restUrl && !!this.restToken;
  }

  private warnDisabledIfNeeded(): void {
    if (this.hasWarnedDisabled || this.isEnabled()) {
      return;
    }

    this.hasWarnedDisabled = true;
    this.logger.warn(
      'Upstash Redis cache is disabled. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
    );
  }

  private prefixedKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
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

  private parseJson<T>(rawJson: string): T | null {
    try {
      return JSON.parse(rawJson) as T;
    } catch {
      return null;
    }
  }

  private readLocalCache(prefixedKey: string): string | null {
    if (this.localCacheTtlSeconds < 1 || this.localCacheMaxEntries < 1) {
      return null;
    }

    const entry = this.localCache.get(prefixedKey);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.localCache.delete(prefixedKey);
      return null;
    }

    return entry.rawJson;
  }

  private writeLocalCache(
    prefixedKey: string,
    rawJson: string,
    sourceTtlSeconds?: number,
  ): void {
    if (this.localCacheTtlSeconds < 1 || this.localCacheMaxEntries < 1) {
      return;
    }

    const ttlSeconds = Math.max(
      1,
      Math.min(
        this.localCacheTtlSeconds,
        Number.isFinite(sourceTtlSeconds)
          ? Math.max(1, Math.trunc(sourceTtlSeconds as number))
          : this.localCacheTtlSeconds,
      ),
    );
    const expiresAt = Date.now() + (ttlSeconds * 1000);

    this.pruneLocalCache();
    this.localCache.set(prefixedKey, { rawJson, expiresAt });
  }

  private deleteLocalCache(prefixedKey: string): void {
    this.localCache.delete(prefixedKey);
  }

  private pruneLocalCache(): void {
    if (this.localCache.size < this.localCacheMaxEntries) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of this.localCache.entries()) {
      if (entry.expiresAt <= now) {
        this.localCache.delete(key);
      }
    }

    while (this.localCache.size >= this.localCacheMaxEntries) {
      const oldestKey = this.localCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.localCache.delete(oldestKey);
    }
  }

  private async request<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: string;
    contentType?: string;
  }): Promise<T | null> {
    if (!this.isEnabled()) {
      return null;
    }
    if (this.isRemoteTemporarilyBypassed()) {
      return null;
    }

    const url = `${this.restUrl}/${input.path.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.restToken}`,
    };
    if (input.body !== undefined) {
      headers['Content-Type'] = input.contentType ?? 'text/plain';
    }

    try {
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        timeoutController.abort();
      }, this.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: input.method,
          headers,
          body: input.body,
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
      const logTarget = input.path.replace(/^\/+/, '') || '<command>';
      if (!response.ok) {
        const errorBody = await response.text();
        const detail = errorBody.trim().length > 0 ? `: ${errorBody.trim()}` : '';
        this.markRemoteTemporarilyUnavailable(
          `request failed (${response.status})${detail}`,
          logTarget,
        );
        return null;
      }

      const payload = (await response.json()) as UpstashResponse<T>;
      if (typeof payload?.error === 'string' && payload.error.length > 0) {
        this.logger.warn(`Upstash command error for ${logTarget}: ${payload.error}`);
        return null;
      }

      this.consecutiveRemoteFailures = 0;
      this.remoteBypassUntilEpochMs = 0;
      return payload?.result ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Upstash error';
      const logTarget = input.path.replace(/^\/+/, '') || '<command>';
      const errorName = typeof error === 'object' && error && 'name' in error
        ? String((error as { name?: string }).name ?? '')
        : '';
      if (errorName === 'AbortError') {
        this.markRemoteTemporarilyUnavailable(
          `request timed out after ${this.requestTimeoutMs}ms`,
          logTarget,
        );
      } else {
        this.markRemoteTemporarilyUnavailable(`request error: ${message}`, logTarget);
      }
      return null;
    }
  }

  private markRemoteTemporarilyUnavailable(reason: string, target: string): void {
    this.consecutiveRemoteFailures = Math.min(this.consecutiveRemoteFailures + 1, 16);
    const now = Date.now();
    const baseCooldown = Math.max(1, this.requestFailureCooldownMs);
    const maxCooldown = Math.max(baseCooldown, this.requestFailureCooldownMaxMs);
    const exponent = Math.min(this.consecutiveRemoteFailures - 1, 8);
    const effectiveCooldownMs = Math.min(
      maxCooldown,
      baseCooldown * (2 ** exponent),
    );
    this.remoteBypassUntilEpochMs = Math.max(
      this.remoteBypassUntilEpochMs,
      now + effectiveCooldownMs,
    );
    this.logger.warn(
      `Upstash request error for ${target}: ${reason}. Bypassing remote cache for ${effectiveCooldownMs}ms`,
    );
  }

  private requestCommand<T>(command: Array<string | number>): Promise<T | null> {
    return this.request<T>({
      method: 'POST',
      path: '',
      body: JSON.stringify(command),
      contentType: 'application/json',
    });
  }
}
