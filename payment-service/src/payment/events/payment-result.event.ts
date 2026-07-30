export type PaymentResultStatus = 'SUCCESS' | 'FAILED';

export class PaymentResultEvent {
  orderId: string;
  paymentId?: string;
  status: PaymentResultStatus;
}
