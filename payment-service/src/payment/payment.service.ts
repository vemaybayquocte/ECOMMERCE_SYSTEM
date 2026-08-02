import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AmqpConnection, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { context, propagation, trace } from '@opentelemetry/api';
import * as CircuitBreaker from 'opossum';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { PaymentRequestedEvent } from './events/payment-requested.event';
import { PaymentResultEvent } from './events/payment-result.event';

const MAX_RETRIES = 3;
const tracer = trace.getTracer('payment-service');

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly exchange: string;
  private readonly retryExchange: string;
  private readonly dlqExchange: string;
  private readonly transientFailureRate: number;
  // Same rationale as order-service's breakers: a burst of gateway
  // failures shouldn't make every payment wait out the full simulated
  // call - once the failure rate crosses the threshold the breaker opens
  // and rejects instantly (which still falls into the existing
  // transient-failure/Nack path below, no new branching needed).
  private readonly gatewayBreaker: CircuitBreaker<[number], PaymentStatus>;

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly amqpConnection: AmqpConnection,
    private readonly configService: ConfigService,
  ) {
    this.exchange = this.configService.get<string>(
      'RABBITMQ_EXCHANGE',
      'ecommerce.events',
    );
    this.retryExchange = `${this.exchange}.retry`;
    this.dlqExchange = `${this.exchange}.dlq`;
    this.transientFailureRate = this.configService.get<number>(
      'PAYMENT_TRANSIENT_FAILURE_RATE',
      0.2,
    );
    const gatewayTimeoutMs = this.configService.get<number>(
      'PAYMENT_GATEWAY_TIMEOUT_MS',
      2_000,
    );
    this.gatewayBreaker = new CircuitBreaker(
      (amount: number) => this.callPaymentGateway(amount),
      {
        timeout: gatewayTimeoutMs,
        errorThresholdPercentage: 50,
        resetTimeout: 10_000,
        rollingCountTimeout: 10_000,
      },
    );
  }

  @RabbitSubscribe({
    exchange: 'ecommerce.events',
    routingKey: 'payment.requested',
    queue: 'payment.requested-queue',
    queueOptions: {
      durable: true,
    },
  })
  async handlePaymentRequested(
    event: PaymentRequestedEvent,
    _rawMessage: unknown,
    headers: Record<string, any>,
  ): Promise<void> {
    // Continue the trace started by order-service instead of starting a
    // disconnected one: extract the traceparent injected into the AMQP
    // message headers, then run this handler (and the span below) inside
    // that extracted context.
    const parentContext = propagation.extract(context.active(), headers ?? {});

    return context.with(parentContext, () =>
      tracer.startActiveSpan('payment.handlePaymentRequested', async (span) => {
        span.setAttribute('order.id', event.orderId);
        try {
          return await this.processPaymentRequested(event, headers);
        } finally {
          span.end();
        }
      }),
    );
  }

  private async processPaymentRequested(
    event: PaymentRequestedEvent,
    headers: Record<string, any>,
  ): Promise<void> {
    // Idempotency: at-least-once delivery means the broker can redeliver a
    // message we already fully processed (e.g. crash right after DB commit
    // but before ack). Skip reprocessing instead of double-charging.
    const existing = await this.paymentRepository.findOne({
      where: { orderId: event.orderId },
    });
    if (existing) {
      this.logger.warn(
        `Order ${event.orderId} already has payment ${existing.id} (${existing.status}) — skipping duplicate delivery`,
      );
      return;
    }

    const xDeath = headers?.['x-death'] as Array<{ count: number }> | undefined;
    const retryCount = xDeath?.[0]?.count ?? 0;

    if (retryCount >= MAX_RETRIES) {
      this.logger.error(
        `Order ${event.orderId} failed ${retryCount} times, moving to DLQ`,
      );
      await this.amqpConnection.publish(
        this.dlqExchange,
        'payment.requested',
        event,
      );
      await this.publishResult(event.orderId, 'FAILED');
      return;
    }

    this.logger.log(
      `Processing payment for order ${event.orderId} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
    );

    // A caught error here (simulated gateway timeout / DB hiccup, or the
    // circuit breaker rejecting because it's open) never throws: throwing
    // would route the exception through Nest's HTTP-oriented
    // ExceptionsHandler (this app also serves HTTP routes), which breaks
    // trying to treat the raw AMQP message as an HTTP response.
    //
    // Retry delay is staged (2s/5s/12s across 3 queues, see
    // rabbitmq.module.ts) rather than a single fixed TTL - the target
    // queue for THIS attempt is picked from the current x-death count
    // (retryCount), and the message is explicitly published there rather
    // than Nack'd, because a queue's dead-letter target is static and
    // can't be chosen per-message through Nack alone. The original
    // message is then acked (implicit, by returning normally) so it
    // doesn't also get redelivered by the main queue itself. Each retry
    // queue still dead-letters back to the main queue automatically via
    // RabbitMQ once its own TTL elapses, so x-death keeps incrementing
    // correctly for the next attempt's routing decision.
    let status: PaymentStatus;
    try {
      status = await this.gatewayBreaker.fire(event.total);
    } catch (err) {
      this.logger.warn(
        `Transient failure processing order ${event.orderId}: ${(err as Error).message}`,
      );
      const retryRoutingKey = `payment.requested.retry-${retryCount + 1}`;
      await this.amqpConnection.publish(
        this.retryExchange,
        retryRoutingKey,
        event,
      );
      return;
    }

    const payment = await this.paymentRepository.save(
      this.paymentRepository.create({
        orderId: event.orderId,
        customerId: event.customerId,
        amount: event.total,
        status,
      }),
    );

    this.logger.log(
      `Payment ${payment.status} for order ${event.orderId} (payment id: ${payment.id})`,
    );

    // Tell the saga orchestrator (order-service) how this step ended so it
    // can confirm or release the inventory reservation accordingly.
    await this.publishResult(
      event.orderId,
      status === PaymentStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
      payment.id,
    );
  }

  private async publishResult(
    orderId: string,
    status: 'SUCCESS' | 'FAILED',
    paymentId?: string,
  ): Promise<void> {
    const routingKey =
      status === 'SUCCESS' ? 'payment.succeeded' : 'payment.failed';
    const resultEvent: PaymentResultEvent = { orderId, paymentId, status };
    try {
      await this.amqpConnection.publish(this.exchange, routingKey, resultEvent);
    } catch (err) {
      this.logger.error(
        `Failed to publish ${routingKey} for order ${orderId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Giả lập cổng thanh toán thật: có độ trễ, một tỉ lệ lỗi kỹ thuật tạm thời
   * (network/timeout -> nên retry), và một tỉ lệ từ chối nghiệp vụ hợp lệ
   * (thẻ bị từ chối -> không cần retry, lưu thẳng FAILED).
   */
  private async callPaymentGateway(amount: number): Promise<PaymentStatus> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (Math.random() < this.transientFailureRate) {
      throw new Error(
        `Simulated transient payment gateway failure for amount ${amount}`,
      );
    }

    return Math.random() < 0.85 ? PaymentStatus.SUCCESS : PaymentStatus.FAILED;
  }
}
