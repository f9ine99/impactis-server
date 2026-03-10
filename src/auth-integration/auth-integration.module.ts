import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthIntegrationService } from './auth-integration.service';
import { BetterAuthJwtGuard } from './better-auth-jwt.guard';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [AuthIntegrationService, BetterAuthJwtGuard],
  exports: [AuthIntegrationService, BetterAuthJwtGuard],
})
export class AuthIntegrationModule {}
