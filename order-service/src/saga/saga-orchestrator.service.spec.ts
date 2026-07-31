import { SagaOrchestratorService } from './saga-orchestrator.service';
import { OrderStatus } from '../order/entities/order.entity';

describe('SagaOrchestratorService', () => {
  let service: SagaOrchestratorService;
  let orderRepository: { update: jest.Mock; findOne: jest.Mock };
  let amqpConnection: { request: jest.Mock; publish: jest.Mock };

  beforeEach(() => {
    orderRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue({ id: 'o1', customerId: 'c1' }),
    };
    amqpConnection = {
      request: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    service = new SagaOrchestratorService(
      orderRepository as any,
      amqpConnection as any,
    );
  });

  it('does not publish order.status-changed for the intermediate INVENTORY_RESERVED status', async () => {
    amqpConnection.request.mockResolvedValue({ success: true });

    await service.handleOrderCreated({
      orderId: 'o1',
      customerId: 'c1',
      total: 10,
      items: [],
      createdAt: new Date().toISOString(),
    });

    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'o1' },
      { status: OrderStatus.INVENTORY_RESERVED },
    );
    expect(amqpConnection.publish).not.toHaveBeenCalledWith(
      expect.anything(),
      'order.status-changed',
      expect.anything(),
    );
  });

  it('publishes order.status-changed CANCELLED when inventory reservation is declined', async () => {
    amqpConnection.request.mockResolvedValue({
      success: false,
      reason: 'insufficient_stock:p1',
    });

    await service.handleOrderCreated({
      orderId: 'o1',
      customerId: 'c1',
      total: 10,
      items: [],
      createdAt: new Date().toISOString(),
    });

    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'o1' },
      { status: OrderStatus.CANCELLED },
    );
    expect(amqpConnection.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'order.status-changed',
      { orderId: 'o1', customerId: 'c1', status: OrderStatus.CANCELLED },
    );
  });

  it('publishes order.status-changed COMPLETED once payment succeeds and inventory is confirmed', async () => {
    amqpConnection.request.mockResolvedValue({ success: true });

    await service.handlePaymentSucceeded({
      orderId: 'o1',
      status: 'SUCCESS',
    });

    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'o1' },
      { status: OrderStatus.COMPLETED },
    );
    expect(amqpConnection.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'order.status-changed',
      { orderId: 'o1', customerId: 'c1', status: OrderStatus.COMPLETED },
    );
  });

  it('publishes order.status-changed CANCELLED after releasing inventory on payment failure', async () => {
    amqpConnection.request.mockResolvedValue({ success: true });

    await service.handlePaymentFailed({
      orderId: 'o1',
      status: 'FAILED',
    });

    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'o1' },
      { status: OrderStatus.CANCELLED },
    );
    expect(amqpConnection.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'order.status-changed',
      { orderId: 'o1', customerId: 'c1', status: OrderStatus.CANCELLED },
    );
  });

  it('does not publish order.status-changed if the order no longer exists', async () => {
    orderRepository.findOne.mockResolvedValue(null);
    amqpConnection.request.mockResolvedValue({ success: true });

    await service.handlePaymentFailed({ orderId: 'ghost', status: 'FAILED' });

    expect(amqpConnection.publish).not.toHaveBeenCalled();
  });
});
