import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdminAudit } from './admin-audit.entity';
import { StaffPrincipal } from './staff-auth.guard';

@Injectable()
export class AdminAuditService {
  constructor(@InjectRepository(AdminAudit) private readonly repo: Repository<AdminAudit>) {}

  /** Registra una acción. Con `manager`, queda en la misma transacción que el cambio. */
  async record(
    staff: StaffPrincipal,
    entry: {
      action: string;
      targetType: string;
      targetId: string;
      reason?: string | null;
      details?: Record<string, unknown>;
    },
    manager?: EntityManager,
  ) {
    const repo = manager ? manager.getRepository(AdminAudit) : this.repo;
    await repo.save(
      repo.create({
        staffId: staff.id,
        staffUsername: staff.username,
        staffRole: staff.role,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        reason: entry.reason?.trim().slice(0, 300) || null,
        details: entry.details ?? null,
      }),
    );
  }

  async list(page = 1, limit = 50, targetId?: string) {
    const take = Math.min(Math.max(limit, 1), 200);
    const [items, total] = await this.repo.findAndCount({
      where: targetId ? { targetId } : {},
      order: { createdAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return { items, total, page: Math.max(page, 1), limit: take };
  }
}
