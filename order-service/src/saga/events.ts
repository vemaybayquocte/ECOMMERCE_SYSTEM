export interface InventoryRpcResult {
  success: boolean;
  reason?: string;
}

export interface PaymentResultEvent {
  orderId: string;
  paymentId?: string;
  status: 'SUCCESS' | 'FAILED';
}
