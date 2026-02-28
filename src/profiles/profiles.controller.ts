import { Body, Controller, Patch, Req, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { ProfileMutationResult, UpdateProfileInput } from './profiles.types';
import { ProfilesService } from './profiles.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'profiles', version: '1' })
@UseGuards(SupabaseJwtGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Patch('me')
  async updateProfile(
    @Req() req: RequestWithUser,
    @Body() input: UpdateProfileInput,
  ): Promise<ProfileMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
      };
    }

    try {
      await this.profiles.updateProfile(user.id, input);
      return {
        success: true,
        message: 'Profile updated successfully.',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to update profile right now.';
      return {
        success: false,
        message,
      };
    }
  }
}
