import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Nack, RabbitRPC } from '@golevelup/nestjs-rabbitmq';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { GetPricesRequest, GetPricesResult } from './rpc';

const EXCHANGE = 'ecommerce.events';

// Minimal shape of what we need from amqplib's ConsumeMessage - avoids
// adding a dependency on amqplib's own types (not installed directly,
// only pulled in transitively by @golevelup/nestjs-rabbitmq).
interface RawAmqpMessage {
  fields: { redelivered: boolean };
}

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
    queueOptions: {
      deadLetterExchange: 'ecommerce.events.dlq',
      deadLetterRoutingKey: 'catalog.requests',
    },
  })
  async getPrices(
    request: GetPricesRequest,
    msg: RawAmqpMessage = { fields: { redelivered: false } },
  ): Promise<GetPricesResult | Nack> {
    // Poison-message backstop: this handler already never throws (see
    // comment above) - the ONLY way a message comes back redelivered is a
    // real process crash mid-handler, before it could ack. Give up after
    // one redelivery and let an operator inspect it in the DLQ instead of
    // risking another crash on the same payload.
    if (msg.fields.redelivered) {
      this.logger.error(
        `catalog.get-prices message was redelivered (likely crashed mid-processing last time) - routing to DLQ instead of retrying`,
      );
      return new Nack(false);
    }

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
