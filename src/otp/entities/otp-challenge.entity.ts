import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('otp_challenges')
export class OtpChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index(['idUser', 'purpose'], { unique: true })
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
