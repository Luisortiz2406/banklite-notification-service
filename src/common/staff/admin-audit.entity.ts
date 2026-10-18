import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Bitácora de acciones de empleados sobre los datos de este servicio. Solo se inserta, nunca se edita. */
@Entity('admin_audit')
@Index('idx_admin_audit_created', ['createdAt'])
export class AdminAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'staff_id', type: 'varchar' })
  staffId: string;

  @Column({ name: 'staff_username', type: 'varchar' })
  staffUsername: string;

  // Rol del empleado al momento de la acción (null en registros anteriores a los roles).
  @Column({ name: 'staff_role', type: 'varchar', nullable: true })
  staffRole: string | null;

  @Column({ type: 'varchar' })
  action: string;

  @Column({ name: 'target_type', type: 'varchar' })
  targetType: string;

  @Index()
  @Column({ name: 'target_id', type: 'varchar' })
  targetId: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
