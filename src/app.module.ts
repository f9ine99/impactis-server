import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthIntegrationModule } from './auth-integration/auth-integration.module';
import { WorkspaceModule } from './workspace/workspace.module';
import configuration from './config/configuration';
import { HealthModule } from './health/health.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProfilesModule } from './profiles/profiles.module';
import { StartupsModule } from './startups/startups.module';
import { FilesModule } from './files/files.module';
import { CacheModule } from './cache/cache.module';
import { ConditionalGetEtagInterceptor } from './http/conditional-get-etag.interceptor';
import { BillingModule } from './billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
    }),
    PrismaModule,
    AuthIntegrationModule,
    WorkspaceModule,
    OrganizationsModule,
    ProfilesModule,
    StartupsModule,
    FilesModule,
    BillingModule,
    CacheModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ConditionalGetEtagInterceptor,
    },
  ],
})
export class AppModule {}
