import { IsString, IsUUID, Matches } from 'class-validator';

export class SendOtpDto {
  @IsUUID()
  idUser: string;

  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato internacional E.164, por ejemplo +573001234567',
  })
  phone: string;
}
