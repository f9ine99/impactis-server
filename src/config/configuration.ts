function parseBoolean(value: string | undefined, fallback: boolean): boolean {
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

export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  webOrigin: process.env.WEB_ORIGIN,
  databaseUrl: process.env.DATABASE_URL,
  betterAuthJwksUrl: process.env.BETTER_AUTH_JWKS_URL,
  betterAuthIssuer: process.env.BETTER_AUTH_ISSUER,
  dbQueryTelemetryEnabled: parseBoolean(process.env.DB_QUERY_TELEMETRY_ENABLED, false),
  dbQueryTelemetryFlushIntervalMs: parseInt(
    process.env.DB_QUERY_TELEMETRY_FLUSH_INTERVAL_MS ?? '60000',
    10,
  ),
  dbSlowQueryThresholdMs: parseInt(
    process.env.DB_SLOW_QUERY_THRESHOLD_MS ?? '120',
    10,
  ),
  dbQueryTag: process.env.DB_QUERY_TAG ?? 'impactis_api',
  dbApplicationName: process.env.DB_APPLICATION_NAME ?? 'impactis_api',
  dbSchemaCheckCacheTtlMs: parseInt(
    process.env.DB_SCHEMA_CHECK_CACHE_TTL_MS ?? '300000',
    10,
  ),
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2BucketName: process.env.R2_BUCKET_NAME,
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  cacheWorkspaceBootstrapTtlSeconds: parseInt(
    process.env.CACHE_WORKSPACE_BOOTSTRAP_TTL_SECONDS ?? '300',
    10,
  ),
  cacheWorkspaceIdentityTtlSeconds: parseInt(
    process.env.CACHE_WORKSPACE_IDENTITY_TTL_SECONDS ?? '300',
    10,
  ),
  cacheWorkspaceSettingsTtlSeconds: parseInt(
    process.env.CACHE_WORKSPACE_SETTINGS_TTL_SECONDS ?? '300',
    10,
  ),
  cacheWorkspaceEmptyTtlSeconds: parseInt(
    process.env.CACHE_WORKSPACE_EMPTY_TTL_SECONDS ?? '30',
    10,
  ),
  cacheTtlJitterPercent: parseInt(
    process.env.CACHE_TTL_JITTER_PERCENT ?? '15',
    10,
  ),
  cacheLockTtlSeconds: parseInt(
    process.env.CACHE_LOCK_TTL_SECONDS ?? '5',
    10,
  ),
  cacheLockWaitMs: parseInt(
    process.env.CACHE_LOCK_WAIT_MS ?? '120',
    10,
  ),
  cacheL1TtlSeconds: parseInt(
    process.env.CACHE_L1_TTL_SECONDS ?? '60',
    10,
  ),
  cacheL1MaxEntries: parseInt(
    process.env.CACHE_L1_MAX_ENTRIES ?? '2000',
    10,
  ),
  cacheTelemetryEnabled: parseBoolean(process.env.CACHE_TELEMETRY_ENABLED, false),
  cacheTelemetryFlushIntervalMs: parseInt(
    process.env.CACHE_TELEMETRY_FLUSH_INTERVAL_MS ?? '60000',
    10,
  ),
  cacheUpstashRequestTimeoutMs: parseInt(
    process.env.CACHE_UPSTASH_REQUEST_TIMEOUT_MS ?? '700',
    10,
  ),
  cacheUpstashFailureCooldownMs: parseInt(
    process.env.CACHE_UPSTASH_FAILURE_COOLDOWN_MS ?? '5000',
    10,
  ),
  cacheUpstashFailureCooldownMaxMs: parseInt(
    process.env.CACHE_UPSTASH_FAILURE_COOLDOWN_MAX_MS ?? '60000',
    10,
  ),
  cacheDebug: parseBoolean(process.env.CACHE_DEBUG, false),
  cacheKeyPrefix: process.env.CACHE_KEY_PREFIX ?? 'impactis',
});
