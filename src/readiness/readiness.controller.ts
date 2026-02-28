import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import { OrganizationReadinessSummaryResult } from './readiness.types';
import { ReadinessService } from './readiness.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'admin/readiness', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

  private parseIsReadyFilter(value: string | null | undefined): boolean | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (!normalized) {
      return null;
    }

    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }

    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }

    return null;
  }

  private getAdminEmailAllowList(): string[] {
    const raw = process.env.ADMIN_USER_EMAILS ?? '';
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
        'Admin readiness endpoint is not configured. Set ADMIN_USER_EMAILS in server environment.',
      );
    }

    const email = this.normalizeOptionalText(user?.email)?.toLowerCase();
    if (!email || !allowList.includes(email)) {
      throw new ForbiddenException('Admin access required');
    }
  }

  @Get()
  async listOrganizationReadinessSummary(
    @Req() req: RequestWithUser,
    @Query('orgType') orgTypeInput?: string,
    @Query('isReady') isReadyInput?: string,
    @Query('search') searchInput?: string,
    @Query('page') pageInput?: string,
    @Query('limit') limitInput?: string,
  ): Promise<OrganizationReadinessSummaryResult> {
    this.assertAdminAccess(req.user);

    const orgType = this.normalizeOptionalText(orgTypeInput)?.toLowerCase() ?? null;
    const isReady = this.parseIsReadyFilter(isReadyInput);
    const search = this.normalizeOptionalText(searchInput);
    const page = this.parsePositiveInteger(pageInput, 1);
    const limit = this.parsePositiveInteger(limitInput, 20);

    return this.readiness.listOrganizationReadinessSummary({
      orgType,
      isReady,
      search,
      page,
      limit,
    });
  }
}
