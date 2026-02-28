import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import {
  CreateStartupDataRoomUploadUrlInput,
  CreateStartupPitchDeckUploadUrlInput,
  CreateStartupReadinessUploadUrlInput,
  StartupPitchDeckUploadUrlPayload,
} from './files.types';
import { FilesService } from './files.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'files', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('startups/readiness/upload-url')
  async createStartupReadinessUploadUrl(
    @Req() req: RequestWithUser,
    @Body() input: CreateStartupReadinessUploadUrlInput,
  ): Promise<StartupPitchDeckUploadUrlPayload> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }

    try {
      const result = await this.files.createStartupReadinessUploadUrl(user.id, input);
      return {
        success: true,
        message: null,
        uploadUrl: result.uploadUrl,
        publicUrl: result.publicUrl,
        objectKey: result.objectKey,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create startup readiness upload URL right now.';
      return {
        success: false,
        message,
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }
  }

  @Post('startups/pitch-deck/upload-url')
  async createStartupPitchDeckUploadUrl(
    @Req() req: RequestWithUser,
    @Body() input: CreateStartupPitchDeckUploadUrlInput,
  ): Promise<StartupPitchDeckUploadUrlPayload> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }

    try {
      const result = await this.files.createStartupPitchDeckUploadUrl(user.id, input);
      return {
        success: true,
        message: null,
        uploadUrl: result.uploadUrl,
        publicUrl: result.publicUrl,
        objectKey: result.objectKey,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create pitch deck upload URL right now.';
      return {
        success: false,
        message,
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }
  }

  @Post('startups/data-room/upload-url')
  async createStartupDataRoomUploadUrl(
    @Req() req: RequestWithUser,
    @Body() input: CreateStartupDataRoomUploadUrlInput,
  ): Promise<StartupPitchDeckUploadUrlPayload> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }

    try {
      const result = await this.files.createStartupDataRoomUploadUrl(user.id, input);
      return {
        success: true,
        message: null,
        uploadUrl: result.uploadUrl,
        publicUrl: result.publicUrl,
        objectKey: result.objectKey,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create startup data room upload URL right now.';
      return {
        success: false,
        message,
        uploadUrl: null,
        publicUrl: null,
        objectKey: null,
      };
    }
  }
}
