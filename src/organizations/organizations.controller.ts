import {
  Body,
  Controller,
  Delete,
  Get,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import {
  CreateOrganizationWithOwnerInput,
  CreateOrganizationInviteInput,
  CreateOrganizationInvitePayload,
  MutationResult,
  OrganizationIncomingInviteView,
  OrganizationMemberDirectoryEntryView,
  OrganizationMembershipExistsView,
  OrganizationMembershipView,
  OrganizationOutgoingInviteView,
  OrganizationVerificationOverviewView,
  OrganizationVerificationView,
  UpdateOrganizationVerificationInput,
  UpdateOrganizationIdentityInput,
} from './organizations.types';
import { OrganizationsService } from './organizations.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

class AcceptOrganizationInviteInput {
  @IsString()
  @MinLength(1)
  inviteToken!: string;
}

@Controller({ path: 'organizations', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseStatusQuery(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) {
      return value
        .map((entry) => this.normalizeOptionalText(entry))
        .filter((entry): entry is string => !!entry)
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    const normalized = this.normalizeOptionalText(value);
    if (!normalized) {
      return [];
    }

    return normalized
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  private parsePositiveInteger(value: string | null | undefined, fallback: number): number {
    const normalized = this.normalizeOptionalText(value);
    if (!normalized) {
      return fallback;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fallback;
    }

    return parsed;
  }

  private getAdminEmailAllowList(): string[] {
    const raw = process.env.ADMIN_USER_EMAILS ?? process.env.ADMIN_EMAILS ?? '';
    if (!raw.trim()) {
      return [];
    }

    return raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }

  private assertAdminAccess(user?: AuthenticatedUser): void {
    const allowList = this.getAdminEmailAllowList();
    if (allowList.length < 1) {
      throw new ForbiddenException(
        'Admin endpoint is not configured. Set ADMIN_USER_EMAILS or ADMIN_EMAILS in server environment.',
      );
    }

    const email = this.normalizeOptionalText(user?.email)?.toLowerCase();
    if (!email || !allowList.includes(email)) {
      throw new ForbiddenException('Admin access required');
    }
  }

  @Get('me/membership')
  async getMyPrimaryOrganizationMembership(
    @Req() req: RequestWithUser,
  ): Promise<OrganizationMembershipView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.organizations.getPrimaryOrganizationMembershipByUserId(user.id);
    } catch {
      return null;
    }
  }

  @Get('me/membership/exists')
  async hasMyOrganizationMembership(
    @Req() req: RequestWithUser,
  ): Promise<OrganizationMembershipExistsView> {
    const user = req.user;
    if (!user) {
      return {
        hasMembership: false,
      };
    }

    try {
      return {
        hasMembership: await this.organizations.hasOrganizationMembershipForUser(user.id),
      };
    } catch {
      return {
        hasMembership: false,
      };
    }
  }

  @Get(':orgId/verification')
  async getOrganizationVerification(
    @Req() req: RequestWithUser,
    @Param('orgId') orgId: string,
  ): Promise<OrganizationVerificationView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.organizations.getOrganizationVerificationByOrgId(user.id, orgId);
    } catch {
      return null;
    }
  }

  @Get(':orgId/invites/outgoing')
  async listOrganizationOutgoingInvites(
    @Req() req: RequestWithUser,
    @Param('orgId') orgId: string,
    @Query('statuses') statusesQuery?: string | string[],
  ): Promise<OrganizationOutgoingInviteView[]> {
    const user = req.user;
    if (!user) {
      return [];
    }

    try {
      const statuses = this.parseStatusQuery(statusesQuery);
      return await this.organizations.listOrganizationInvitesForOrg(user.id, orgId, statuses);
    } catch {
      return [];
    }
  }

  @Get(':orgId/invites/outgoing/count')
  async countOrganizationOutgoingInvites(
    @Req() req: RequestWithUser,
    @Param('orgId') orgId: string,
    @Query('statuses') statusesQuery?: string | string[],
  ): Promise<{ count: number }> {
    const user = req.user;
    if (!user) {
      return { count: 0 };
    }

    try {
      const statuses = this.parseStatusQuery(statusesQuery);
      return {
        count: await this.organizations.countOrganizationInvitesForOrg(user.id, orgId, statuses),
      };
    } catch {
      return { count: 0 };
    }
  }

  @Get(':orgId/members/active')
  async listActiveOrganizationMembers(
    @Req() req: RequestWithUser,
    @Param('orgId') orgId: string,
  ): Promise<OrganizationMemberDirectoryEntryView[]> {
    const user = req.user;
    if (!user) {
      return [];
    }

    try {
      return await this.organizations.listActiveOrganizationMembersForOrg(user.id, orgId);
    } catch {
      return [];
    }
  }

  @Get('admin/verification-overview')
  async listOrganizationVerificationOverview(
    @Req() req: RequestWithUser,
    @Query('limit') limitInput?: string,
  ): Promise<OrganizationVerificationOverviewView[]> {
    this.assertAdminAccess(req.user);
    const limit = this.parsePositiveInteger(limitInput, 100);

    try {
      return await this.organizations.listOrganizationsWithVerification(limit);
    } catch {
      return [];
    }
  }

  @Patch('admin/verification/:orgId')
  async updateOrganizationVerification(
    @Req() req: RequestWithUser,
    @Param('orgId') orgId: string,
    @Body() input: UpdateOrganizationVerificationInput,
  ): Promise<OrganizationVerificationView | null> {
    const user = req.user;
    this.assertAdminAccess(user);
    if (!user) {
      return null;
    }

    try {
      return await this.organizations.setOrganizationVerificationStatus({
        orgId,
        status: input.status,
        reviewedByUserId: user.id,
        notes: input.notes,
      });
    } catch {
      return null;
    }
  }

  @Post()
  async createOrganizationWithOwner(
    @Req() req: RequestWithUser,
    @Body() input: CreateOrganizationWithOwnerInput,
  ): Promise<MutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        orgId: null,
      };
    }

    try {
      const orgId = await this.organizations.createOrganizationWithOwner(user.id, input);
      return {
        success: true,
        message: 'Organization created.',
        orgId,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create organization right now.';
      return {
        success: false,
        message,
        orgId: null,
      };
    }
  }

  @Get('invites/my')
  async listMyOrganizationInvites(
    @Req() req: RequestWithUser,
  ): Promise<OrganizationIncomingInviteView[]> {
    const user = req.user;
    if (!user) {
      return [];
    }

    try {
      return await this.organizations.listMyOrganizationInvites(user.id);
    } catch {
      return [];
    }
  }

  @Patch('identity')
  async updateOrganizationIdentity(
    @Req() req: RequestWithUser,
    @Body() input: UpdateOrganizationIdentityInput,
  ): Promise<MutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      const orgId = await this.organizations.updateOrganizationIdentity(user.id, input);
      return {
        success: true,
        message: 'Organization identity updated.',
        orgId,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to update organization identity right now.';
      return {
        success: false,
        message,
        orgId: null,
      };
    }
  }

  @Post('invites')
  async createOrganizationInvite(
    @Req() req: RequestWithUser,
    @Body() input: CreateOrganizationInviteInput,
  ): Promise<CreateOrganizationInvitePayload> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        inviteId: null,
        inviteToken: null,
      };
    }

    try {
      return await this.organizations.createOrganizationInvite(user.id, input);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create organization invite right now.';
      return {
        success: false,
        message,
        inviteId: null,
        inviteToken: null,
      };
    }
  }

  @Delete('invites/:inviteId')
  async revokeOrganizationInvite(
    @Req() req: RequestWithUser,
    @Param('inviteId') inviteId: string,
  ): Promise<MutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      await this.organizations.revokeOrganizationInvite(user.id, inviteId);
      return {
        success: true,
        message: 'Organization invite revoked.',
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to revoke invite right now.';
      return {
        success: false,
        message,
      };
    }
  }

  @Post('invites/accept')
  async acceptOrganizationInvite(
    @Req() req: RequestWithUser,
    @Body() input: AcceptOrganizationInviteInput,
  ): Promise<MutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      const orgId = await this.organizations.acceptOrganizationInvite(user.id, input.inviteToken);
      return {
        success: true,
        message: 'Invite accepted successfully.',
        orgId,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to accept invite right now.';
      return {
        success: false,
        message,
        orgId: null,
      };
    }
  }
}
