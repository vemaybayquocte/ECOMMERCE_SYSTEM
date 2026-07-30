import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OutboxEvent])],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
