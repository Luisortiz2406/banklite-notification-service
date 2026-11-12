import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

const ANA = '11111111-1111-4111-8111-111111111111';
const guardsOf = (target: object) => Reflect.getMetadata('__guards__', target) ?? [];

describe('NotificationsController', () => {
  const service = {
    createFromDto: jest.fn().mockResolvedValue([{ id: 'n1' }]),
    findForUser: jest.fn().mockResolvedValue([]),
    markRead: jest.fn().mockResolvedValue({ read: true }),
  };
  const controller = new NotificationsController(service as unknown as NotificationsService);
  const request = { user: { idUser: ANA } } as never;

  it('crear un aviso es solo de servicio a servicio (clave interna); consultar y marcar leído exigen sesión', () => {
    expect(guardsOf(NotificationsController.prototype.create)).toContain(InternalKeyGuard);
    expect(guardsOf(NotificationsController.prototype.findForUser)).toContain(JwtAuthGuard);
    expect(guardsOf(NotificationsController.prototype.markRead)).toContain(JwtAuthGuard);
  });

  it('crea desde el cuerpo; consulta con el cliente de la sesión (por defecto solo el canal de la app)', async () => {
    const dto = { idUser: ANA, event: 'account.closed' } as never;
    await controller.create(dto);
    expect(service.createFromDto).toHaveBeenCalledWith(dto);

    await controller.findForUser(ANA, request);
    expect(service.findForUser).toHaveBeenLastCalledWith(ANA, ANA, 'in_app', false);
    await controller.findForUser(ANA, request, 'email', 'true');
    expect(service.findForUser).toHaveBeenLastCalledWith(ANA, ANA, 'email', true);

    await controller.markRead('n1', request);
    expect(service.markRead).toHaveBeenCalledWith('n1', ANA);
  });
});
