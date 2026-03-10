import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { BetterAuthJwtGuard } from '../auth-integration/better-auth-jwt.guard';
import { BillingService } from './billing.service';
import {
  BillingMeView,
  BillingMutationResult,
  BillingPlansView,
  ListBillingPlansQueryInput,
  UpdateBillingSubscriptionInput,
} from './billing.types';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

@Controller({ path: 'billing', version: '1' })
@UseGuards(BetterAuthJwtGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  async listBillingPlans(
    @Req() req: RequestWithUser,
    @Query() query: ListBillingPlansQueryInput,
  ): Promise<BillingPlansView> {
    const user = req.user;
    if (!user) {
      return {
        segment: 'all',
        plans: [],
      };
    }

    try {
      return await this.billing.listBillingPlansForUser(user.id, {
        segment: query.segment ?? null,
      });
    } catch {
      return {
        segment: 'all',
        plans: [],
      };
    }
  }

  @Get('me')
  async getBillingMe(
    @Req() req: RequestWithUser,
  ): Promise<BillingMeView | null> {
    const user = req.user;
    if (!user) {
      return null;
    }

    try {
      return await this.billing.getBillingMeForUser(user.id);
    } catch {
      return null;
    }
  }

  @Patch('subscription')
  async updateBillingSubscription(
    @Req() req: RequestWithUser,
    @Body() input: UpdateBillingSubscriptionInput,
  ): Promise<BillingMutationResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        currentPlan: null,
      };
    }

    try {
      const currentPlan = await this.billing.updateBillingSubscriptionForUser(user.id, input);
      return {
        success: true,
        message: 'Subscription updated.',
        currentPlan,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to update subscription right now.';
      return {
        success: false,
        message,
        currentPlan: null,
      };
    }
  }
}
