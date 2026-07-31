export interface GetPricesRequest {
  productIds: string[];
}

export interface GetPricesResult {
  prices: { productId: string; price: number }[];
  missing: string[];
}
