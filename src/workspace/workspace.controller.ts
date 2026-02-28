import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import { WorkspaceService } from './workspace.service';
import {
  WorkspaceBootstrapSnapshot,
  WorkspaceCoreTeamMember,
  WorkspaceDashboardSnapshot,
  WorkspaceIdentitySnapshot,
  WorkspaceSettingsSnapshot,
} from './workspace.types';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'workspace', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get('identity')
  async getWorkspaceIdentity(
    @Req() req: RequestWithUser,
  ): Promise<WorkspaceIdentitySnapshot | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.workspaceService.getWorkspaceIdentityForUser(user.id);
    } catch {
      return null;
    }
  }

  @Get('core-team')
  async listWorkspaceCoreTeam(
    @Req() req: RequestWithUser,
    @Query('orgId') orgId?: string,
  ): Promise<WorkspaceCoreTeamMember[]> {
    const user = req.user;
    if (!user) {
      return [];
    }

    try {
      return await this.workspaceService.listOrganizationCoreTeamForUser(user.id, orgId);
    } catch {
      return [];
    }
  }

  @Get('settings-snapshot')
  async getWorkspaceSettingsSnapshot(
    @Req() req: RequestWithUser,
    @Query('section') section?: string,
  ): Promise<WorkspaceSettingsSnapshot | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    return this.workspaceService.getWorkspaceSettingsSnapshotForUser(user.id, section);
  }

  @Get('dashboard')
  async getWorkspaceDashboard(
    @Req() req: RequestWithUser,
  ): Promise<WorkspaceDashboardSnapshot | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    return this.workspaceService.getWorkspaceDashboardSnapshotForUser(user.id);
  }

  @Get('bootstrap')
  async getWorkspaceBootstrap(
    @Req() req: RequestWithUser,
  ): Promise<WorkspaceBootstrapSnapshot | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    return this.workspaceService.getWorkspaceBootstrapSnapshotForUser(user.id);
  }
}
