import { IsString, IsUUID, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsUUID()
  idUser: string;

  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato internacional E.164, por ejemplo +573001234567',
  })
  phone: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code debe tener 6 dígitos' })
  code: string;
}
