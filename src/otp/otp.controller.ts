import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { OtpService } from './otp.service';

@Controller('otp')
@UseGuards(InternalKeyGuard)
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  send(@Body() dto: SendOtpDto) {
    return this.otpService.sendCode(dto.idUser, dto.phone);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyOtpDto) {
    return this.otpService.verifyCode(dto.idUser, dto.phone, dto.code);
  }

  @Post('password-reset/send')
  @HttpCode(HttpStatus.OK)
  sendPasswordReset(@Body() dto: SendOtpDto) {
    return this.otpService.sendCode(dto.idUser, dto.phone, 'password_reset');
  }

  @Post('password-reset/verify')
  @HttpCode(HttpStatus.OK)
  verifyPasswordReset(@Body() dto: VerifyOtpDto) {
    return this.otpService.verifyCode(dto.idUser, dto.phone, dto.code, 'password_reset');
  }

  @Get('status/:id_user')
  status(@Param('id_user', ParseUUIDPipe) idUser: string) {
    return this.otpService.isVerified(idUser);
  }
}
