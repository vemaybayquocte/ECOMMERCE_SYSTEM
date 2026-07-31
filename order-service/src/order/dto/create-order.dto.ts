export class CreateOrderDto {
  customerId: string;
  // price is intentionally not accepted here: order-service looks up the
  // authoritative price per productId from catalog-service (see
  // OrderService.createOrder) instead of trusting a client-supplied value.
  items: { productId: string; quantity: number }[];
}
