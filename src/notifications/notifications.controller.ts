import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  private requesterId(request: Request): string {
    return (request as any).user?.idUser as string;
  }

  // Uso interno: cualquier microservicio puede empujar un evento aquí
  // directamente (útil mientras no lo publique todavía por RabbitMQ, o
  // para pruebas). Aplica la misma política de channel-policy.ts.
  @Post()
  @UseGuards(InternalKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateNotificationDto) {
    return this.notifications.createFromDto(dto);
  }

  // Dashboard: por defecto solo trae el canal in_app (lo demás es
  // correo/WhatsApp, que ya se entregó fuera de la app).
  @Get(':id_user')
  @UseGuards(JwtAuthGuard)
  findForUser(
    @Param('id_user', ParseUUIDPipe) idUser: string,
    @Req() request: Request,
    @Query('channel') channel: string = 'in_app',
    @Query('unread') unread?: string,
  ) {
    return this.notifications.findForUser(idUser, this.requesterId(request), channel, unread === 'true');
  }

  @Put(':id/read')
  @UseGuards(JwtAuthGuard)
  markRead(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.notifications.markRead(id, this.requesterId(request));
  }
}
