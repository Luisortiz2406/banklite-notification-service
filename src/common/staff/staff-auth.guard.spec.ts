import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { StaffAuthGuard, StaffPrincipal, StaffRoles } from './staff-auth.guard';

// Prueba el guard común del panel (idéntico en todos los servicios con panel administrativo).

const SECRET = 'secreto-de-empleados-para-pruebas-0123456789';
const jwt = new JwtService({});

@StaffRoles('support', 'admin')
class PanelDePrueba {
  porClase() {}
  @StaffRoles('admin')
  soloAdmin() {}
}

function contextFor(handler: () => void, authorization?: string) {
  const request: { headers: Record<string, string>; staff?: StaffPrincipal } = {
    headers: authorization ? { authorization } : {},
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => PanelDePrueba,
  } as unknown as ExecutionContext;
  return { context, request };
}

const guard = (secret: string | undefined = SECRET) =>
  new StaffAuthGuard(jwt, new ConfigService({ STAFF_JWT_SECRET: secret }), new Reflector());
const token = (payload: Record<string, unknown>, secret = SECRET) => jwt.sign(payload, { secret, algorithm: 'HS256' });
const staffToken = (overrides: Record<string, unknown> = {}) =>
  `Bearer ${token({ sub: 'emp-1', type: 'staff', role: 'admin', username: 'laura', ...overrides })}`;

describe('StaffAuthGuard (token de empleado)', () => {
  const panel = new PanelDePrueba();

  it('sin cabecera Bearer da 401', () => {
    expect(() => guard().canActivate(contextFor(panel.soloAdmin).context)).toThrow(UnauthorizedException);
    expect(() => guard().canActivate(contextFor(panel.soloAdmin, 'Basic abc').context)).toThrow(UnauthorizedException);
  });

  it('si el servicio no tiene STAFF_JWT_SECRET, el panel no se abre', () => {
    expect(() => guard('').canActivate(contextFor(panel.soloAdmin, staffToken()).context)).toThrow('STAFF_JWT_SECRET');
  });

  it('un token firmado con otro secreto o roto da 401', () => {
    const forged = `Bearer ${token({ sub: 'x', type: 'staff', role: 'admin' }, 'otro-secreto-distinto-de-32-caracteres!!')}`;
    expect(() => guard().canActivate(contextFor(panel.soloAdmin, forged).context)).toThrow('inválida o expirada');
    expect(() => guard().canActivate(contextFor(panel.soloAdmin, 'Bearer no.es.jwt').context)).toThrow(
      UnauthorizedException,
    );
  });

  it('un token de cliente, sin sub o con un rol desconocido no es de empleado', () => {
    const rejected = [
      staffToken({ type: 'access' }),
      staffToken({ sub: undefined }),
      staffToken({ role: 'superusuario' }),
    ];
    for (const authorization of rejected) {
      expect(() => guard().canActivate(contextFor(panel.soloAdmin, authorization).context)).toThrow(
        'no es de un empleado',
      );
    }
  });

  it('el rol del método manda sobre el de la clase', () => {
    expect(() => guard().canActivate(contextFor(panel.soloAdmin, staffToken({ role: 'support' })).context)).toThrow(
      ForbiddenException,
    );
    expect(guard().canActivate(contextFor(panel.soloAdmin, staffToken({ role: 'admin' })).context)).toBe(true);
  });

  it('sin rol en el método aplica el de la clase', () => {
    expect(guard().canActivate(contextFor(panel.porClase, staffToken({ role: 'support' })).context)).toBe(true);
    expect(() => guard().canActivate(contextFor(panel.porClase, staffToken({ role: 'compliance' })).context)).toThrow(
      'Tu rol no permite esta acción',
    );
  });

  it('deja al empleado en la petición, con su documento y la hora de emisión si vienen', () => {
    const withDoc = contextFor(panel.soloAdmin, staffToken({ docHash: 'abc123' }));
    guard().canActivate(withDoc.context);
    expect(withDoc.request.staff).toMatchObject({ id: 'emp-1', username: 'laura', role: 'admin', docHash: 'abc123' });
    expect(typeof withDoc.request.staff?.issuedAt).toBe('number');

    const minimal = contextFor(panel.soloAdmin, `Bearer ${token({ sub: 'emp-2', type: 'staff', role: 'admin' })}`);
    guard().canActivate(minimal.context);
    expect(minimal.request.staff).toMatchObject({ id: 'emp-2', username: 'emp-2', docHash: null });
  });
});
