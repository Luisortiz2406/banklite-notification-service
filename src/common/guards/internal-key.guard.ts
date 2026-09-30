import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Protege POST /notifications (uso interno entre microservicios).
 * Exige el header `x-internal-key` con el valor de INTERNAL_API_KEY,
 * idéntico al de auth-service / kyc-service. Falla cerrado si no está
 * configurado.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_API_KEY');
    const request = context.switchToHttp().getRequest<Request>();
    const received = request.headers['x-internal-key'];

    if (!expected || typeof received !== 'string') {
      throw new UnauthorizedException('Clave interna requerida');
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Clave interna inválida');
    }
    return true;
  }
}
