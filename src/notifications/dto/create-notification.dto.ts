import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateNotificationDto {
  @IsUUID()
  idUser: string;

  // Debe coincidir con una clave de CHANNEL_POLICY (o cae en defaultRules).
  @IsString()
  event: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
