import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventConsumerService } from './events/event-consumer.service';
import { HealthController } from './health.controller';
import { Notification } from './notifications/entities/notification.entity';
import { NotificationsModule } from './notifications/notifications.module';
import { OtpChallenge } from './otp/entities/otp-challenge.entity';
import { OtpController } from './otp/otp.controller';
import { OtpService } from './otp/otp.service';
import { InternalKeyGuard } from './common/guards/internal-key.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [Notification, OtpChallenge],
        synchronize: true, // demo académica; en producción usar migraciones
        logging: false,
      }),
    }),
    TypeOrmModule.forFeature([OtpChallenge]),
    NotificationsModule,
  ],
  controllers: [HealthController, OtpController],
  providers: [EventConsumerService, OtpService, InternalKeyGuard],
})
export class AppModule {}
