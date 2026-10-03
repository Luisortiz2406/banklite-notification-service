import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export type StaffRole = 'support' | 'admin';

export interface StaffPrincipal {
  id: string;
  username: string;
  role: StaffRole;
}

const ROLES_KEY = 'staffRoles';

/** Restringe un endpoint del panel a ciertos roles. Sin decorador: cualquier empleado. */
export const StaffRoles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Valida el token de EMPLEADO emitido por auth-service (POST /auth/admin/login).
 * Se firma con STAFF_JWT_SECRET, distinto del secreto de los clientes, y lleva
 * type 'staff': un token de cliente nunca pasa este guard ni viceversa.
 */
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Token de empleado no proporcionado');

    const secret = this.config.get<string>('STAFF_JWT_SECRET');
    if (!secret) throw new UnauthorizedException('El panel administrativo no está configurado (STAFF_JWT_SECRET).');

    let payload: { sub?: string; type?: string; role?: StaffRole; username?: string };
    try {
      payload = this.jwt.verify(header.slice('Bearer '.length), { secret });
    } catch {
      throw new UnauthorizedException('Sesión de empleado inválida o expirada');
    }
    if (payload.type !== 'staff' || !payload.sub || !payload.role) {
      throw new UnauthorizedException('El token no es de un empleado');
    }

    const allowed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed?.length && !allowed.includes(payload.role)) {
      throw new ForbiddenException('Tu rol no permite esta acción.');
    }

    (request as any).staff = { id: payload.sub, username: payload.username ?? payload.sub, role: payload.role } satisfies StaffPrincipal;
    return true;
  }
}
