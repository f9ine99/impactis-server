import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class AuthIntegrationService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

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
      return this.verifyTokenViaSupabaseAuth(token);
    }
  }

  private async verifyTokenViaSupabaseAuth(token: string): Promise<AuthenticatedUser> {
    const supabaseUrl = this.configService.get<string>('supabaseUrl')?.trim();
    const supabaseAnonKey = this.configService.get<string>('supabaseAnonKey')?.trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new UnauthorizedException('Invalid or expired Supabase token');
    }

    const authUrl = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;

    try {
      const response = await fetch(authUrl, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          apikey: supabaseAnonKey,
        },
      });

      if (!response.ok) {
        throw new UnauthorizedException('Invalid or expired Supabase token');
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const id = typeof payload['id'] === 'string' ? payload['id'] : null;
      if (!id) {
        throw new UnauthorizedException('Invalid or expired Supabase token');
      }

      return {
        id,
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
        raw: payload,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired Supabase token');
    }
  }
}
