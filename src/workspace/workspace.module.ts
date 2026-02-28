import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { ReadinessModule } from '../readiness/readiness.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [ReadinessModule, BillingModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
