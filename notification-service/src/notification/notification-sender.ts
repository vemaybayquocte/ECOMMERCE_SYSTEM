import { Injectable, Logger } from '@nestjs/common';

export interface NotificationSender {
  send(customerId: string, message: string): Promise<void>;
}

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');

/**
 * Stand-in for a real provider (nodemailer, SendGrid, Twilio, ...) - same
 * "simulate the external system" pattern payment-service uses for its
 * gateway. Swap the provider bound in notification.module.ts.
 */
@Injectable()
export class LogNotificationSender implements NotificationSender {
  private readonly logger = new Logger(LogNotificationSender.name);

  async send(customerId: string, message: string): Promise<void> {
    this.logger.log(`Notify customer ${customerId}: ${message}`);
  }
}
