import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class AuthIntegrationService {
  constructor(private readonly jwtService: JwtService) {}

  async verifyAuthorizationHeader(authHeader?: string | null): Promise<AuthenticatedUser> {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    try {
      const decoded = this.jwtService.verify(token) as Record<string, unknown>;
      const id = decoded.sub ?? decoded['user_id'];

      if (!id || typeof id !== 'string') {
        throw new UnauthorizedException('Token is missing subject');
      }

      const email = typeof decoded['email'] === 'string' ? decoded['email'] : undefined;

      return {
        id,
        email,
        raw: decoded,
      };
    } catch {
      // Any verification error means the token is invalid or expired
      throw new UnauthorizedException('Invalid or expired auth token');
    }
  }
}
