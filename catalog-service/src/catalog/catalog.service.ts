import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RabbitRPC } from '@golevelup/nestjs-rabbitmq';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { GetPricesRequest, GetPricesResult } from './rpc';

const EXCHANGE = 'ecommerce.events';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  findAll(): Promise<Product[]> {
    return this.productRepository.find();
  }

  findOne(id: string): Promise<Product | null> {
    return this.productRepository.findOne({ where: { id } });
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const existing = await this.productRepository.findOne({
      where: { productId: dto.productId },
    });
    if (existing) {
      throw new ConflictException(
        `Product ${dto.productId} already registered`,
      );
    }

    return this.productRepository.save(this.productRepository.create(dto));
  }

  // Authoritative pricing lookup for order-service: never throw past this
  // boundary, same rule as inventory-service's RPC handlers - golevelup
  // routes a thrown exception here through Nest's HTTP ExceptionsHandler
  // (this service also serves HTTP routes) which silently breaks the AMQP
  // reply, and the caller's amqpConnection.request() just times out.
  @RabbitRPC({
    exchange: EXCHANGE,
    routingKey: 'catalog.get-prices',
    queue: 'catalog.get-prices-queue',
  })
  async getPrices(request: GetPricesRequest): Promise<GetPricesResult> {
    try {
      const products = await this.productRepository.find();
      const byProductId = new Map(products.map((p) => [p.productId, p]));

      const prices: { productId: string; price: number }[] = [];
      const missing: string[] = [];

      for (const productId of request.productIds) {
        const product = byProductId.get(productId);
        if (product) {
          prices.push({ productId, price: product.price });
        } else {
          missing.push(productId);
        }
      }

      return { prices, missing };
    } catch (err) {
      this.logger.error(`catalog.get-prices failed: ${(err as Error).message}`);
      return { prices: [], missing: request.productIds };
    }
  }
}
