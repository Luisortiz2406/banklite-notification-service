import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Proyección local (read model) del contacto de cada usuario, armada con los
 * eventos que ya llegan con `email`/`nombreCompleto` (account.created,
 * identity.email_confirmed, intento_fallido_login...). Sirve para notificar por
 * correo eventos que no traen el email, como transaction.completed de Ledger,
 * sin consultar la base de Auth ni KYC (4.10 sin joins entre microservicios).
 */
@Entity('user_contacts')
export class UserContact {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ name: 'nombre_completo', type: 'varchar', nullable: true })
  nombreCompleto: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
