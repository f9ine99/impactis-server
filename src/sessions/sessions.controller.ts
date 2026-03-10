import { Controller, Delete, Get, Param, Req, UseGuards } from '@nestjs/common';
import { BetterAuthJwtGuard } from '../auth-integration/better-auth-jwt.guard';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SessionsService } from './sessions.service';
import { SessionListResponse } from './sessions.types';

interface RequestWithUser {
    user?: AuthenticatedUser;
}

@Controller({ path: 'sessions', version: '1' })
@UseGuards(BetterAuthJwtGuard)
export class SessionsController {
    constructor(private readonly sessions: SessionsService) { }

    @Get()
    async listSessions(@Req() req: RequestWithUser): Promise<SessionListResponse> {
        const user = req.user;
        if (!user) {
            return { sessions: [] };
        }

        const sessions = await this.sessions.getSessionsForUser(user.id);
        return { sessions };
    }

    @Delete(':sessionId')
    async revokeSession(
        @Req() req: RequestWithUser,
        @Param('sessionId') sessionId: string,
    ): Promise<{ success: boolean; message: string }> {
        const user = req.user;
        if (!user) {
            return { success: false, message: 'Unauthorized' };
        }

        const result = await this.sessions.revokeSession(user.id, sessionId);
        return {
            success: result.count > 0,
            message: result.count > 0 ? 'Session revoked.' : 'Session not found.',
        };
    }

    @Delete()
    async revokeOtherSessions(
        @Req() req: RequestWithUser,
    ): Promise<{ success: boolean; message: string; count: number }> {
        const user = req.user;
        if (!user) {
            return { success: false, message: 'Unauthorized', count: 0 };
        }

        // Extract current session ID from the JWT claims (Supabase uses 'sid')
        const sessionId = (user.raw?.['sid'] || user.raw?.['session_id']) as string;

        if (!sessionId || typeof sessionId !== 'string') {
            return { success: false, message: 'Could not determine current session.', count: 0 };
        }

        const result = await this.sessions.revokeOtherSessions(user.id, sessionId);
        return {
            success: true,
            message: `Revoked ${result.count} session(s).`,
            count: result.count,
        };
    }
}
