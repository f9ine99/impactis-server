import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { BetterAuthJwtGuard } from '../auth-integration/better-auth-jwt.guard';
import { ConnectionsService } from './connections.service';
import { CreateConnectionRequestInput } from './connections.types';
import type {
  ConnectionMessageView,
  ConnectionRequestView,
  ConnectionView,
} from './connections.types';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'connections', version: '1' })
@UseGuards(BetterAuthJwtGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post('requests')
  async createRequest(
    @Req() req: RequestWithUser,
    @Body() input: CreateConnectionRequestInput,
  ): Promise<ConnectionRequestView | { error: string }> {
    const user = req.user;
    if (!user) {
      return { error: 'Unauthorized' };
    }
    try {
      return await this.connections.createRequest(user.id, input);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to send request' };
    }
  }

  @Get('requests/incoming')
  async listIncoming(
    @Req() req: RequestWithUser,
  ): Promise<ConnectionRequestView[]> {
    const user = req.user;
    if (!user) return [];
    try {
      return await this.connections.listIncomingRequests(user.id);
    } catch {
      return [];
    }
  }

  @Get('requests/outgoing')
  async listOutgoing(
    @Req() req: RequestWithUser,
  ): Promise<ConnectionRequestView[]> {
    const user = req.user;
    if (!user) return [];
    try {
      return await this.connections.listOutgoingRequests(user.id);
    } catch {
      return [];
    }
  }

  @Post('requests/:id/accept')
  async acceptRequest(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
  ): Promise<ConnectionView | { error: string }> {
    const user = req.user;
    if (!user) return { error: 'Unauthorized' };
    try {
      return await this.connections.acceptRequest(user.id, id);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to accept' };
    }
  }

  @Post('requests/:id/reject')
  async rejectRequest(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
  ): Promise<{ success: boolean } | { error: string }> {
    const user = req.user;
    if (!user) return { error: 'Unauthorized' };
    try {
      await this.connections.rejectRequest(user.id, id);
      return { success: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to reject' };
    }
  }

  @Get('pending-count')
  async getPendingCount(@Req() req: RequestWithUser): Promise<{ count: number }> {
    const user = req.user;
    if (!user) return { count: 0 };
    try {
      const count = await this.connections.countPendingIncoming(user.id);
      return { count };
    } catch {
      return { count: 0 };
    }
  }

  @Get()
  async listConnections(
    @Req() req: RequestWithUser,
  ): Promise<ConnectionView[]> {
    const user = req.user;
    if (!user) return [];
    try {
      return await this.connections.listConnections(user.id);
    } catch {
      return [];
    }
  }

  @Get(':connectionId/messages')
  async listMessages(
    @Req() req: RequestWithUser,
    @Param('connectionId') connectionId: string,
  ): Promise<ConnectionMessageView[] | { error: string }> {
    const user = req.user;
    if (!user) return { error: 'Unauthorized' };
    try {
      return await this.connections.listMessages(user.id, connectionId);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to load messages' };
    }
  }

  @Post(':connectionId/messages')
  async sendMessage(
    @Req() req: RequestWithUser,
    @Param('connectionId') connectionId: string,
    @Body() body: { body: string },
  ): Promise<ConnectionMessageView | { error: string }> {
    const user = req.user;
    if (!user) return { error: 'Unauthorized' };
    try {
      return await this.connections.sendMessage(
        user.id,
        connectionId,
        body?.body ?? '',
      );
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to send message' };
    }
  }
}
