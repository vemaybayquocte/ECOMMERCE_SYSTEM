import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryService } from './inventory.service';
import { StockItem } from './entities/stock-item.entity';
import { Reservation } from './entities/reservation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([StockItem, Reservation])],
  providers: [InventoryService],
})
export class InventoryModule {}
