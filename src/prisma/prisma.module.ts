import { Global, Module } from '@nestjs/common';
import { DbQueryTelemetryService } from './db-query-telemetry.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DbQueryTelemetryService],
  exports: [PrismaService, DbQueryTelemetryService],
})
export class PrismaModule {}
