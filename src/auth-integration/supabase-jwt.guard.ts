import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AuthIntegrationService, AuthenticatedUser } from './auth-integration.service';

declare module 'http' {
  interface IncomingMessage {
    user?: AuthenticatedUser;
  }
}

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  constructor(private readonly authIntegration: AuthIntegrationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctxType = context.getType<'http' | 'ws' | 'rpc'>();

    if (ctxType === 'http') {
      const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; user?: AuthenticatedUser }>();
      const authHeader = req.headers['authorization'];
      const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      req.user = await this.authIntegration.verifyAuthorizationHeader(headerValue);
      return true;
    }

    if (ctxType === 'ws') {
      const client = context
        .switchToWs()
        .getClient<Socket & { user?: AuthenticatedUser }>();

      if (client.user) {
        return true;
      }

      const authTokenRaw = client.handshake.auth?.token;
      const authToken = typeof authTokenRaw === 'string' ? authTokenRaw.trim() : '';
      const headerAuth = client.handshake.headers.authorization;
      const headerToken = Array.isArray(headerAuth) ? headerAuth[0] : headerAuth;
      const bearer =
        authToken.length > 0
          ? authToken.startsWith('Bearer ')
            ? authToken
            : `Bearer ${authToken}`
          : headerToken;

      client.user = await this.authIntegration.verifyAuthorizationHeader(bearer);
      return true;
    }

    throw new UnauthorizedException('Unsupported context type for SupabaseJwtGuard');
  }
}
