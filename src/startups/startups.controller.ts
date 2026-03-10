import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { BetterAuthJwtGuard } from '../auth-integration/better-auth-jwt.guard';
import {
  StartupDataRoomDocumentView,
  StartupMutationResult,
  StartupPostView,
  StartupProfileView,
  StartupReadinessView,
  UpsertStartupDataRoomDocumentInput,
  UpdateStartupPostInput,
  UpdateStartupProfileInput,
} from './startups.types';
import { StartupsService } from './startups.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'startups', version: '1' })
@UseGuards(BetterAuthJwtGuard)
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

  @Get('data-room/documents')
  async getStartupDataRoomDocuments(
    @Req() req: RequestWithUser,
  ): Promise<StartupDataRoomDocumentView[]> {
    const user = req.user;
    if (!user) {
      return [];
    }

    try {
      return await this.startups.listStartupDataRoomDocuments(user.id);
    } catch {
      return [];
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

  @Post('data-room/documents')
  async upsertStartupDataRoomDocument(
    @Req() req: RequestWithUser,
    @Body() input: UpsertStartupDataRoomDocumentInput,
  ): Promise<StartupMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      await this.startups.upsertStartupDataRoomDocument(user.id, input);
      return {
        success: true,
        message: 'Data room document saved.',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to save data room document right now.';
      return {
        success: false,
        message,
      };
    }
  }

  @Delete('data-room/documents/:documentId')
  async deleteStartupDataRoomDocument(
    @Req() req: RequestWithUser,
    @Param('documentId') documentId: string,
  ): Promise<StartupMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      await this.startups.deleteStartupDataRoomDocument(user.id, documentId);
      return {
        success: true,
        message: 'Data room document removed.',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to remove data room document right now.';
      return {
        success: false,
        message,
      };
    }
  }
}
