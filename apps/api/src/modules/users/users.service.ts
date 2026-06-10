import { Injectable, NotFoundException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { MailerService } from '../mailer/mailer.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) { }

  findAll(tenantId: string, branchId?: string) {
    const select: (keyof import('./entities/user.entity').User)[] = [
      'id', 'firstName', 'lastName', 'email',
      'phone', 'role', 'employeeCode', 'branchId', 'createdAt', 'permissions',
    ];

    // Owners and managers are tenant-wide — they must always appear
    // regardless of which branch is being viewed. Branch-level staff
    // (cashier, waiter, kitchen, inventory) are scoped to their branch.
    if (branchId) {
      return this.repo.find({
        where: [
          // Branch-scoped staff for this specific branch
          { tenantId, isActive: true, branchId },
          // Tenant-wide roles visible across all branches
          { tenantId, isActive: true, role: 'owner' as any },
          { tenantId, isActive: true, role: 'manager' as any },
        ],
        select,
        order: { createdAt: 'DESC' },
      });
    }

    return this.repo.find({
      where: { tenantId, isActive: true },
      select,
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const u = await this.repo.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  async create(data: Partial<User> & { password: string }) {
    if (!data.branchId && data.role !== 'owner') {
      throw new BadRequestException(`A specific branch must be assigned for the ${data.role} role`);
    }

    const existing = await this.repo.findOne({
      where: [
        { tenantId: data.tenantId, email: data.email },
        { tenantId: data.tenantId, phone: data.phone },
      ],
    });
    if (existing) throw new ConflictException('User already exists with this email/phone');

    const passwordHash = await bcrypt.hash(data.password, 12);
    // ✅ PIN is hashed with bcrypt — now fits in VARCHAR(72)
    const pin = data.pin ? await bcrypt.hash(String(data.pin), 10) : undefined;

    const user = this.repo.create({
      ...data,
      passwordHash,
      ...(pin !== undefined ? { pin } : {}),
    });
    await this.repo.save(user);

    // Send staff invite email if user has an email (non-blocking)
    if (user.email) {
      this.sendStaffInviteEmail(user).catch((err) =>
        this.logger.error(`Failed to send staff invite email: ${err.message}`),
      );
    }

    const { passwordHash: _ph, refreshToken: _rt, pin: _pin, ...safe } = user as any;
    return safe;
  }

  async update(id: string, tenantId: string, data: Partial<User> & { password?: string }) {
    const user = await this.findOne(id, tenantId);
    
    if (user.role === 'owner' && data.role && data.role !== 'owner') {
      const ownerCount = await this.repo.count({ where: { tenantId, role: 'owner' as any, isActive: true } });
      if (ownerCount <= 1) {
        throw new ConflictException('Cannot change the role of the last active owner');
      }
    }

    const targetBranchId = data.branchId !== undefined ? data.branchId : user.branchId;
    const targetRole = data.role || user.role;
    if (!targetBranchId && targetRole !== 'owner') {
      throw new BadRequestException(`A specific branch must be assigned for the ${targetRole} role`);
    }

    const patch: any = { ...data };
    
    if (patch.password) {
      patch.passwordHash = await bcrypt.hash(patch.password, 12);
      delete patch.password;
    }
    
    // Remove pin from patch if it exists since it's obsolete
    if ('pin' in patch) delete patch.pin;

    await this.repo.update(id, patch);
    return this.findOne(id, tenantId);
  }

  async deactivate(id: string, tenantId: string) {
    const user = await this.findOne(id, tenantId);
    
    if (user.role === 'owner') {
      const ownerCount = await this.repo.count({ where: { tenantId, role: 'owner' as any, isActive: true } });
      if (ownerCount <= 1) {
        throw new ConflictException('Cannot deactivate the last active owner account');
      }
    }

    return this.repo.update(id, { isActive: false });
  }

  // ✅ ADD THIS NEW METHOD FOR PERMANENT DELETION
  async permanentDelete(id: string, tenantId: string) {
    const user = await this.findOne(id, tenantId);

    if (user.role === 'owner') {
      const ownerCount = await this.repo.count({ where: { tenantId, role: 'owner' as any } });
      if (ownerCount <= 1) {
        throw new ConflictException('Cannot permanently delete the last owner account');
      }
    }

    // Permanent delete from database
    await this.repo.delete(id);

    return {
      success: true,
      message: 'User permanently deleted successfully',
    };
  }

  async updatePermissions(id: string, tenantId: string, permissions: Record<string, any>) {
    const user = await this.findOne(id, tenantId);
    const merged = { ...(user.permissions || {}), ...permissions };
    await this.repo.update(id, { permissions: merged });
    return this.findOne(id, tenantId);
  }

  // ── Email Helpers ──────────────────────────────────────────────────────────

  private async sendStaffInviteEmail(user: User): Promise<void> {
    // Fetch branch name
    let branchName = 'Main Branch';
    if (user.branchId) {
      const [branch] = await this.dataSource.query(
        `SELECT name FROM branches WHERE id = $1`,
        [user.branchId],
      );
      branchName = branch?.name ?? branchName;
    }

    // Fetch tenant (business) name
    const [tenant] = await this.dataSource.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [user.tenantId],
    );
    const businessName = tenant?.name ?? 'Dine&Stay OS';

    await this.mailer.sendStaffInvite({
      to: user.email,
      employeeName: `${user.firstName} ${user.lastName || ''}`.trim(),
      role: user.role,
      branchName,
      businessName,
    });
  }
}