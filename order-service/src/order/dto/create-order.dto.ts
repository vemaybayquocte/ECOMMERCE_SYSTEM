export class CreateOrderDto {
  customerId: string;
  items: { productId: string; quantity: number; price: number }[];
}
