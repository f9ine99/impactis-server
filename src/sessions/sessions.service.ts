import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActiveSession } from './sessions.types';

interface SessionRow {
    id: string;
    user_id: string;
    ip: string | null;
    user_agent: string | null;
    created_at: Date | string;
    updated_at: Date | string;
}

interface DeleteResult {
    count: number;
}

@Injectable()
export class SessionsService {
    private readonly logger = new Logger(SessionsService.name);

    constructor(private readonly prisma: PrismaService) { }

    async getSessionsForUser(userId: string): Promise<ActiveSession[]> {
    // Supabase-based auth.sessions table is not present in the current Postgres schema.
    // Until Better Auth session storage is wired into this service, return an empty list
    // so the API succeeds without noisy errors.
    this.logger.debug(`Session listing is currently disabled for user ${userId}.`);
    return [];
    }

    async revokeSession(userId: string, sessionId: string): Promise<DeleteResult> {
        try {
            const rows = await this.prisma.$queryRaw<{ id: string }[]>(
                `DELETE FROM auth.sessions WHERE id = $1 AND user_id = $2 RETURNING id`,
                sessionId,
                userId,
            );

            return { count: rows.length };
        } catch (error) {
            this.logger.error(
                `Failed to revoke session ${sessionId} for user ${userId}`,
                error instanceof Error ? error.stack : String(error),
            );
            return { count: 0 };
        }
    }

    async revokeOtherSessions(userId: string, currentSessionId: string): Promise<DeleteResult> {
        try {
            const rows = await this.prisma.$queryRaw<{ id: string }[]>(
                `DELETE FROM auth.sessions WHERE user_id = $1 AND id != $2 RETURNING id`,
                userId,
                currentSessionId,
            );

            return { count: rows.length };
        } catch (error) {
            this.logger.error(
                `Failed to revoke other sessions for user ${userId}`,
                error instanceof Error ? error.stack : String(error),
            );
            return { count: 0 };
        }
    }
}
