import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export type NotificationChannel = 'in_app' | 'email' | 'whatsapp';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

/**
 * Tabla notifications.
 *
 * Un mismo evento de dominio (p. ej. identity.verified) puede generar VARIAS
 * filas, una por canal (según channel-policy.ts), porque el contenido y el
 * ciclo de vida de cada canal son distintos:
 *   - in_app: se lee/no se lee dentro del dashboard (columna `read`).
 *   - email/whatsapp: se entrega o falla, no tiene estado "leído" (columna `status`).
 *
 * `dedupeKey` evita duplicados si RabbitMQ reentrega el mismo mensaje
 * (at-least-once delivery): idUser + event + channel + occurredAt.
 */
@Entity('notifications')
@Unique(['dedupeKey'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // Nombre del evento de dominio que originó esta notificación
  // (identity.verified, usuario_autenticado, intento_fallido_login, ...).
  @Column()
  event: string;

  @Column({ type: 'varchar' })
  channel: NotificationChannel;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: NotificationStatus;

  // Solo tiene sentido para channel = 'in_app'.
  @Column({ default: false })
  read: boolean;

  // Datos crudos del evento, por si el frontend necesita un link/accountId/etc.
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Index({ unique: true })
  @Column({ name: 'dedupe_key', type: 'varchar' })
  dedupeKey: string;

  // Reintentos de entrega (email): intentos hechos, cuándo toca el siguiente y el último error.
  @Column({ name: 'delivery_attempts', type: 'int', default: 0 })
  deliveryAttempts: number;

  @Index()
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
