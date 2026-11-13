import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventConsumerService } from './events/event-consumer.service';
import { HealthController } from './health.controller';
import { Notification } from './notifications/entities/notification.entity';
import { UserContact } from './notifications/entities/user-contact.entity';
import { NotificationsModule } from './notifications/notifications.module';
import { OtpChallenge } from './otp/entities/otp-challenge.entity';
import { OtpController } from './otp/otp.controller';
import { OtpService } from './otp/otp.service';
import { InternalKeyGuard } from './common/guards/internal-key.guard';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { AdminAuditService } from './common/staff/admin-audit.service';
import { StaffAuthGuard } from './common/staff/staff-auth.guard';
import { AdminNotificationsController } from './notifications/admin-notifications.controller';
import { validateEnv } from './config/env.validation';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    MetricsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
          { key: 'JWT_SECRET', type: 'secret' },
          { key: 'STAFF_JWT_SECRET', type: 'secret' },
          { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
          { key: 'DATABASE_URL', type: 'url' },
          { key: 'RABBITMQ_URL', type: 'url', optional: true },
        ],
        ['JWT_SECRET', 'STAFF_JWT_SECRET'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [Notification, UserContact, OtpChallenge, AdminAudit],
        synchronize: true, // demo académica; en producción usar migraciones
        logging: false,
      }),
    }),
    TypeOrmModule.forFeature([OtpChallenge, Notification, AdminAudit]),
    JwtModule.register({}),
    NotificationsModule,
  ],
  controllers: [AdminNotificationsController, HealthController, OtpController],
  providers: [EventConsumerService, OtpService, InternalKeyGuard, AdminAuditService, StaffAuthGuard],
})
export class AppModule {}
