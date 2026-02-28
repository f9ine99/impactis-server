import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthIntegrationService } from './auth-integration.service';
import { SupabaseJwtGuard } from './supabase-jwt.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('supabaseJwtSecret'),
        signOptions: {
          algorithm: 'HS256',
        },
      }),
    }),
  ],
  providers: [AuthIntegrationService, SupabaseJwtGuard],
  exports: [AuthIntegrationService, SupabaseJwtGuard],
})
export class AuthIntegrationModule {}
