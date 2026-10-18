-- Datos de ejemplo de notification_db (notification-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;

INSERT INTO public.user_contacts (id_user, email, nombre_completo, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'ana.perez@banklite.test', 'Ana Pérez', '2026-10-01 09:01:00-05'),
  ('22222222-2222-4222-8222-222222222222', 'carlos.gomez@banklite.test', 'Carlos Gómez', '2026-10-01 09:06:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.notifications (id, id_user, event, channel, title, body, status, read, dedupe_key, created_at) VALUES
  ('42000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'transaction.completed', 'in_app', 'Recibiste $150.000', 'Ana Pérez te envió $150.000: Arriendo compartido.', 'sent', false, '22222222-2222-4222-8222-222222222222:transaction.completed:in_app:2026-10-02T15:00:00.000Z', '2026-10-02 10:00:00-05'),
  ('42000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'transaction.completed', 'in_app', 'Pagaste tu factura', 'Pagaste $85.000 a Acueducto de Bogotá.', 'sent', true, '11111111-1111-4111-8111-111111111111:transaction.completed:in_app:2026-10-04T15:00:00.000Z', '2026-10-04 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
