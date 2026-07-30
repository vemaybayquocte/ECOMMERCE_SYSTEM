import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { RabbitRPC } from '@golevelup/nestjs-rabbitmq';
import { StockItem } from './entities/stock-item.entity';
import {
  Reservation,
  ReservationStatus,
  ReservedItem,
} from './entities/reservation.entity';
import { InsufficientStockError } from './errors';

const DEFAULT_STOCK_QUANTITY = 1000;

export interface ReserveRequest {
  orderId: string;
  items: ReservedItem[];
}

export interface OrderIdRequest {
  orderId: string;
}

export interface RpcResult {
  success: boolean;
  reason?: string;
}

/**
 * All three RPC handlers below deliberately never let an exception escape:
 * @golevelup/nestjs-rabbitmq routes a thrown error through Nest's
 * HTTP-oriented ExceptionsHandler (this service also serves /health and
 * /metrics over HTTP), which tries to treat the raw AMQP message as an
 * HTTP response and silently swallows the reply — the caller's
 * amqpConnection.request() would just hang until it times out. Returning a
 * plain { success, reason } object sidesteps that entirely (same fix as
 * payment-service's Nack pattern, applied to the RPC style instead).
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(StockItem)
    private readonly stockRepository: Repository<StockItem>,
    @InjectRepository(Reservation)
    private readonly reservationRepository: Repository<Reservation>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @RabbitRPC({
    exchange: 'ecommerce.events',
    routingKey: 'inventory.reserve',
    queue: 'inventory.reserve-queue',
  })
  async reserve(request: ReserveRequest): Promise<RpcResult> {
    try {
      const existing = await this.reservationRepository.findOne({
        where: { orderId: request.orderId },
      });
      if (existing) {
        this.logger.warn(
          `Reservation for order ${request.orderId} already exists (${existing.status}) — idempotent no-op`,
        );
        return { success: existing.status !== ReservationStatus.RELEASED };
      }

      await this.dataSource.transaction(async (manager) => {
        for (const item of request.items) {
          const quantity = Number(item.quantity);
          if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new InsufficientStockError(item.productId);
          }

          await this.ensureStockExists(manager, item.productId);

          // Atomic conditional update instead of read-then-write: two
          // concurrent reservations for the same product can't both pass a
          // separate availability check and then both increment (classic
          // oversell race). The WHERE clause makes the check and the
          // increment a single atomic operation.
          const result = await manager
            .createQueryBuilder()
            .update(StockItem)
            .set({
              reservedQuantity: () => `"reservedQuantity" + ${quantity}`,
            })
            .where('"productId" = :productId', { productId: item.productId })
            .andWhere('"availableQuantity" - "reservedQuantity" >= :quantity', {
              quantity,
            })
            .execute();

          if (result.affected === 0) {
            throw new InsufficientStockError(item.productId);
          }
        }

        await manager.save(
          Reservation,
          manager.create(Reservation, {
            orderId: request.orderId,
            items: request.items,
            status: ReservationStatus.RESERVED,
          }),
        );
      });

      this.logger.log(`Reserved stock for order ${request.orderId}`);
      return { success: true };
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        this.logger.warn(
          `Reservation failed for order ${request.orderId}: ${err.message}`,
        );
        return {
          success: false,
          reason: `insufficient_stock:${err.productId}`,
        };
      }
      this.logger.error(
        `Error reserving stock for order ${request.orderId}: ${(err as Error).message}`,
      );
      return { success: false, reason: 'internal_error' };
    }
  }

  @RabbitRPC({
    exchange: 'ecommerce.events',
    routingKey: 'inventory.confirm',
    queue: 'inventory.confirm-queue',
  })
  async confirm(request: OrderIdRequest): Promise<RpcResult> {
    try {
      const reservation = await this.reservationRepository.findOne({
        where: { orderId: request.orderId },
      });
      if (!reservation) {
        this.logger.warn(
          `No reservation found for order ${request.orderId} to confirm`,
        );
        return { success: false, reason: 'reservation_not_found' };
      }
      if (reservation.status === ReservationStatus.CONFIRMED) {
        return { success: true };
      }

      await this.dataSource.transaction(async (manager) => {
        for (const item of reservation.items) {
          await manager.decrement(
            StockItem,
            { productId: item.productId },
            'availableQuantity',
            item.quantity,
          );
          await manager.decrement(
            StockItem,
            { productId: item.productId },
            'reservedQuantity',
            item.quantity,
          );
        }

        reservation.status = ReservationStatus.CONFIRMED;
        await manager.save(Reservation, reservation);
      });

      this.logger.log(`Confirmed stock for order ${request.orderId}`);
      return { success: true };
    } catch (err) {
      this.logger.error(
        `Error confirming stock for order ${request.orderId}: ${(err as Error).message}`,
      );
      return { success: false, reason: 'internal_error' };
    }
  }

  @RabbitRPC({
    exchange: 'ecommerce.events',
    routingKey: 'inventory.release',
    queue: 'inventory.release-queue',
  })
  async release(request: OrderIdRequest): Promise<RpcResult> {
    try {
      const reservation = await this.reservationRepository.findOne({
        where: { orderId: request.orderId },
      });
      if (!reservation) {
        this.logger.warn(
          `No reservation found for order ${request.orderId} to release — nothing to compensate`,
        );
        return { success: true };
      }
      if (reservation.status !== ReservationStatus.RESERVED) {
        return { success: true };
      }

      await this.dataSource.transaction(async (manager) => {
        for (const item of reservation.items) {
          await manager.decrement(
            StockItem,
            { productId: item.productId },
            'reservedQuantity',
            item.quantity,
          );
        }

        reservation.status = ReservationStatus.RELEASED;
        await manager.save(Reservation, reservation);
      });

      this.logger.log(`Released stock for order ${request.orderId}`);
      return { success: true };
    } catch (err) {
      this.logger.error(
        `Error releasing stock for order ${request.orderId}: ${(err as Error).message}`,
      );
      return { success: false, reason: 'internal_error' };
    }
  }

  private async ensureStockExists(
    manager: EntityManager,
    productId: string,
  ): Promise<void> {
    const existing = await manager.findOne(StockItem, { where: { productId } });
    if (existing) {
      return;
    }

    // Demo convenience: auto-seed unknown products instead of requiring a
    // separate catalog-management step. A real system would reject unknown
    // productIds instead.
    await manager.save(
      StockItem,
      manager.create(StockItem, {
        productId,
        availableQuantity: DEFAULT_STOCK_QUANTITY,
        reservedQuantity: 0,
      }),
    );
    this.logger.log(
      `Auto-seeded stock for new product ${productId} (${DEFAULT_STOCK_QUANTITY} units)`,
    );
  }
}
