import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth-integration/auth-integration.service';
import { SupabaseJwtGuard } from '../auth-integration/supabase-jwt.guard';
import { BillingStripeService } from './billing-stripe.service';
import {
  BillingStripeRedirectResult,
  BillingStripeWebhookResult,
  CreateStripeCheckoutSessionInput,
  CreateStripePortalSessionInput,
} from './billing.types';

interface RequestWithUser {
  user?: AuthenticatedUser;
  rawBody?: Buffer;
  body?: unknown;
}

@Controller({ path: 'billing/stripe', version: '1' })
export class BillingStripeController {
  constructor(private readonly billingStripe: BillingStripeService) {}

  @Post('checkout-session')
  @UseGuards(SupabaseJwtGuard)
  async createCheckoutSession(
    @Req() req: RequestWithUser,
    @Body() input: CreateStripeCheckoutSessionInput,
  ): Promise<BillingStripeRedirectResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        mode: null,
        redirectUrl: null,
        currentPlan: null,
      };
    }

    try {
      return await this.billingStripe.createCheckoutSessionForUser({
        userId: user.id,
        userEmail: user.email ?? null,
        checkout: input,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to create Stripe checkout session.';
      return {
        success: false,
        message,
        mode: null,
        redirectUrl: null,
        currentPlan: null,
      };
    }
  }

  @Post('portal-session')
  @UseGuards(SupabaseJwtGuard)
  async createPortalSession(
    @Req() req: RequestWithUser,
    @Body() input: CreateStripePortalSessionInput,
  ): Promise<BillingStripeRedirectResult> {
    const user = req.user;
    if (!user) {
      return {
        success: false,
        message: 'Unauthorized',
        mode: null,
        redirectUrl: null,
        currentPlan: null,
      };
    }

    try {
      return await this.billingStripe.createPortalSessionForUser({
        userId: user.id,
        userEmail: user.email ?? null,
        portal: input,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to create Stripe portal session.';
      return {
        success: false,
        message,
        mode: null,
        redirectUrl: null,
        currentPlan: null,
      };
    }
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RequestWithUser,
    @Headers('stripe-signature') stripeSignature?: string,
  ): Promise<BillingStripeWebhookResult> {
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!rawBody) {
      return {
        received: false,
        message: 'Missing raw request body for Stripe signature verification',
      };
    }

    try {
      return await this.billingStripe.handleWebhook({
        rawBody,
        stripeSignature: stripeSignature ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stripe webhook handling failed';
      return {
        received: false,
        message,
      };
    }
  }
}
