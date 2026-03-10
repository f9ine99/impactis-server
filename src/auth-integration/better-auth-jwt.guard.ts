import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthenticatedUser } from './auth-integration.service';

declare module 'http' {
  interface IncomingMessage {
    user?: AuthenticatedUser;
  }
}

@Injectable()
export class BetterAuthJwtGuard implements CanActivate {
  private jwkSet:
    | ReturnType<typeof createRemoteJWKSet>
    | null = null;

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctxType = context.getType<'http' | 'ws' | 'rpc'>();

    if (ctxType === 'http') {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | string[] | undefined>;
        user?: AuthenticatedUser;
      }>();

      const authHeader = req.headers['authorization'];
      const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      req.user = await this.verifyAuthorizationHeader(headerValue);
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

      client.user = await this.verifyAuthorizationHeader(bearer);
      return true;
    }

    throw new UnauthorizedException('Unsupported context type for BetterAuthJwtGuard');
  }

  private async getJwkSet() {
    if (!this.jwkSet) {
      const jwksUrl = this.config.get<string>('betterAuthJwksUrl')?.trim();
      if (!jwksUrl) {
        // During transition we may still be using Supabase tokens; let the caller
        // decide whether to fall back instead of hard-failing here.
        throw new Error('Better Auth JWKS URL is not configured');
      }
      this.jwkSet = createRemoteJWKSet(new URL(jwksUrl));
    }
    return this.jwkSet;
  }

  private async verifyAuthorizationHeader(authHeader?: string | null): Promise<AuthenticatedUser> {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    try {
      const jwkSet = await this.getJwkSet();
      const issuer = this.config.get<string>('betterAuthIssuer')?.trim();
      const { payload } = await jwtVerify(token, jwkSet, issuer ? { issuer } : undefined);
      return this.toAuthenticatedUser(payload);
    } catch {
      throw new UnauthorizedException('Invalid or expired auth token');
    }
  }

  private toAuthenticatedUser(payload: JWTPayload): AuthenticatedUser {
    const idValue = payload.sub ?? (payload as any).user_id ?? (payload as any).id;
    const id = typeof idValue === 'string' ? idValue : String(idValue ?? '');

    if (!id) {
      throw new UnauthorizedException('Token is missing subject');
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email
        : typeof (payload as any).user_email === 'string'
          ? (payload as any).user_email
          : undefined;

    return {
      id,
      email,
      raw: payload as unknown as Record<string, unknown>,
    };
  }
}

