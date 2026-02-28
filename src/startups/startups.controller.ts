import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import {
  StartupMutationResult,
  StartupPostView,
  StartupProfileView,
  StartupReadinessView,
  UpdateStartupPostInput,
  UpdateStartupProfileInput,
} from './startups.types';
import { StartupsService } from './startups.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'startups', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class StartupsController {
  constructor(private readonly startups: StartupsService) {}

  @Get('readiness')
  async getStartupReadiness(
    @Req() req: RequestWithUser,
  ): Promise<StartupReadinessView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.startups.getStartupReadiness(user.id);
    } catch {
      return null;
    }
  }

  @Get('profile')
  async getStartupProfile(
    @Req() req: RequestWithUser,
  ): Promise<StartupProfileView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.startups.getStartupProfile(user.id);
    } catch {
      return null;
    }
  }

  @Get('post')
  async getStartupPost(
    @Req() req: RequestWithUser,
  ): Promise<StartupPostView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.startups.getStartupPost(user.id);
    } catch {
      return null;
    }
  }

  @Patch('profile')
  async updateStartupProfile(
    @Req() req: RequestWithUser,
    @Body() input: UpdateStartupProfileInput,
  ): Promise<StartupMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      await this.startups.updateStartupProfile(user.id, input);
      return {
        success: true,
        message: 'Startup profile updated.',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to update startup profile right now.';
      return {
        success: false,
        message,
      };
    }
  }

  @Patch('post')
  async updateStartupPost(
    @Req() req: RequestWithUser,
    @Body() input: UpdateStartupPostInput,
  ): Promise<StartupMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        postId: null,
      };
    }

    try {
      const postId = await this.startups.updateStartupPost(user.id, input);
      return {
        success: true,
        message: 'Startup post updated.',
        postId,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to update startup post right now.';
      return {
        success: false,
        message,
        postId: null,
      };
    }
  }
}
