export interface OrderStatusChangedEvent {
  orderId: string;
  customerId: string;
  status: string;
}
