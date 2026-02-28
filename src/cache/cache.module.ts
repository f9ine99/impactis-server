import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheTelemetryService } from './cache-telemetry.service';
import { UpstashRedisCacheService } from './upstash-redis-cache.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [UpstashRedisCacheService, CacheTelemetryService],
  exports: [UpstashRedisCacheService, CacheTelemetryService],
})
export class CacheModule {}
