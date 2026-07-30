import { OrderItem } from '../entities/order.entity';

export class OrderCreatedEvent {
  orderId: string;
  customerId: string;
  total: number;
  items: OrderItem[];
  createdAt: string;
}
