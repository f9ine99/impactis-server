import { Module } from '@nestjs/common';
import { StartupsController } from './startups.controller';
import { StartupsService } from './startups.service';
import { ReadinessModule } from '../readiness/readiness.module';

@Module({
  imports: [ReadinessModule],
  controllers: [StartupsController],
  providers: [StartupsService],
})
export class StartupsModule {}
