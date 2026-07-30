import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ReservationStatus {
  RESERVED = 'RESERVED',
  CONFIRMED = 'CONFIRMED',
  RELEASED = 'RELEASED',
}

export interface ReservedItem {
  productId: string;
  quantity: number;
}

/**
 * One row per saga (keyed by orderId): tracks what was reserved so
 * confirm/release know exactly what to act on, and doubles as the
 * idempotency key for redelivered reserve/confirm/release requests.
 */
@Entity('reservations')
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  orderId: string;

  @Column({ type: 'jsonb' })
  items: ReservedItem[];

  @Column({ type: 'enum', enum: ReservationStatus })
  status: ReservationStatus;

  @CreateDateColumn()
  createdAt: Date;
}
