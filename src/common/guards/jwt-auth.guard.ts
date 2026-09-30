import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Valida el JWT emitido por Auth & IAM Service, igual que en
 * kyc-service y account-service (en producción esto lo haría el API
 * Gateway; aquí se replica para que el servicio sea funcional por sí solo).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token no proporcionado');
    }

    const token = authHeader.slice('Bearer '.length);

    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_SECRET'),
      });
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Token no es de tipo access');
      }
      (request as any).user = { idUser: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
