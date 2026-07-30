import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../order/entities/order.entity';
import { SagaOrchestratorService } from './saga-orchestrator.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  providers: [SagaOrchestratorService],
})
export class SagaModule {}
