import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import {
  LogNotificationSender,
  NOTIFICATION_SENDER,
} from './notification-sender';

@Module({
  providers: [
    NotificationService,
    { provide: NOTIFICATION_SENDER, useClass: LogNotificationSender },
  ],
})
export class NotificationModule {}
