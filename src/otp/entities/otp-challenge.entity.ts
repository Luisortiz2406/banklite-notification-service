import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Índice compuesto a nivel de clase: un reto por usuario y propósito
// (registro y recuperación de clave conviven para el mismo idUser).
@Entity('otp_challenges')
@Index(['idUser', 'purpose'], { unique: true })
export class OtpChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'varchar', default: 'registration' })
  purpose: 'registration' | 'password_reset';

  @Column({ length: 16 })
  phone: string;

  @Column({ name: 'code_hash' })
  codeHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt: Date;

  @Column({ default: 0 })
  attempts: number;

  @Column({ default: false })
  verified: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
