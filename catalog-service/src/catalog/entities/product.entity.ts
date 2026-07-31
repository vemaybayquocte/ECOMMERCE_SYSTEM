import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The free-form identifier order/inventory items reference as
  // "productId" - distinct from this row's own uuid primary key.
  @Column({ unique: true })
  productId: string;

  @Column()
  name: string;

  @Column('float')
  price: number;

  @Column({ nullable: true })
  description?: string;

  @CreateDateColumn()
  createdAt: Date;
}
