import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AmqpConnection,
  Nack,
  RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { context, propagation, trace } from '@opentelemetry/api';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { PaymentRequestedEvent } from './events/payment-requested.event';
import { PaymentResultEvent } from './events/payment-result.event';

const MAX_RETRIES = 3;
const tracer = trace.getTracer('payment-service');

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly exchange: string;
  private readonly dlqExchange: string;
  private readonly transientFailureRate: number;

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
    this.dlqExchange = `${this.exchange}.dlq`;
    this.transientFailureRate = this.configService.get<number>(
      'PAYMENT_TRANSIENT_FAILURE_RATE',
      0.2,
    );
  }

  @RabbitSubscribe({
    exchange: 'ecommerce.events',
    routingKey: 'payment.requested',
    queue: 'payment.requested-queue',
    queueOptions: {
      durable: true,
      deadLetterExchange: 'ecommerce.events.retry',
      deadLetterRoutingKey: 'payment.requested',
    },
  })
  async handlePaymentRequested(
    event: PaymentRequestedEvent,
    _rawMessage: unknown,
    headers: Record<string, any>,
  ): Promise<Nack | void> {
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
  ): Promise<Nack | void> {
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

    // A caught error here (simulated gateway timeout / DB hiccup) returns a
    // Nack instead of throwing: throwing would route the exception through
    // Nest's HTTP-oriented ExceptionsHandler (this app also serves HTTP
    // routes), which breaks trying to treat the raw AMQP message as an HTTP
    // response. Returning Nack(false) triggers the queue's DLX directly ->
    // the message lands in the retry queue, waits out its TTL, then
    // dead-letters back here for another attempt.
    let status: PaymentStatus;
    try {
      status = await this.callPaymentGateway(event.total);
    } catch (err) {
      this.logger.warn(
        `Transient failure processing order ${event.orderId}: ${(err as Error).message}`,
      );
      return new Nack(false);
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
