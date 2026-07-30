import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Transactional outbox: written in the SAME DB transaction as the business
 * row it describes (see OrderService.createOrder). Debezium captures this
 * table via CDC and routes it to Kafka, so an event can never be lost even
 * if the process crashes right after the order is committed.
 */
@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  aggregateType: string;

  @Column()
  aggregateId: string;

  @Column()
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
