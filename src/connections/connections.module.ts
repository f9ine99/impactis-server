import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

@Module({
  imports: [PrismaModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
