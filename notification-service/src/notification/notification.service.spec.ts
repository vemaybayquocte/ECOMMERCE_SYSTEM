import { NotificationService } from './notification.service';
import { NotificationSender } from './notification-sender';

describe('NotificationService', () => {
  let service: NotificationService;
  let sender: { send: jest.Mock };

  beforeEach(() => {
    sender = { send: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationService(sender as unknown as NotificationSender);
  });

  it('sends a notification with the customer id and a message describing the new status', async () => {
    await service.handleOrderStatusChanged({
      orderId: 'o1',
      customerId: 'c1',
      status: 'COMPLETED',
    });

    expect(sender.send).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('o1'),
    );
    expect(sender.send).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('COMPLETED'),
    );
  });

  it('never throws even if the sender fails (RPC/subscribe handlers must not throw)', async () => {
    sender.send.mockRejectedValue(new Error('smtp down'));

    await expect(
      service.handleOrderStatusChanged({
        orderId: 'o2',
        customerId: 'c2',
        status: 'CANCELLED',
      }),
    ).resolves.toBeUndefined();
  });
});
