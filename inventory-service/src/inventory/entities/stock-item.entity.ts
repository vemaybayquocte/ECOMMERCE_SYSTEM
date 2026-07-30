import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('stock_items')
export class StockItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  productId: string;

  @Column('int')
  availableQuantity: number;

  @Column('int', { default: 0 })
  reservedQuantity: number;
}
