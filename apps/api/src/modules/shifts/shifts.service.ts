import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Shift, ShiftStatus, ShiftDepartment } from './entities/shift.entity';
import { ShiftDenomination } from './entities/shift-denomination.entity';
import { MailerService } from '../mailer/mailer.service';

export interface DenominationDto {
  note2000?: number; note500?: number; note200?: number; note100?: number;
  note50?: number;   note20?: number;  note10?: number;
  coin5?: number;    coin2?: number;   coin1?: number;
}

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(ShiftDenomination)
    private readonly denomRepo: Repository<ShiftDenomination>,
    @InjectDataSource()
    private readonly db: DataSource,
    private readonly mailer: MailerService,
  ) {}

  async openShift(
    branchId: string,
    tenantId: string,
    userId: string,
    openingCash: number,
    denominations?: DenominationDto,
    department: ShiftDepartment = ShiftDepartment.RESTAURANT,
  ) {
    const existing = await this.shiftRepo.findOne({
      where: { branchId, tenantId, status: ShiftStatus.OPEN, department },
    });
    if (existing) {
      const deptLabel = department === ShiftDepartment.HOTEL ? 'hotel' : 'restaurant';
      throw new BadRequestException(`A ${deptLabel} shift is already open for this branch`);
    }

    const prefix = department === ShiftDepartment.HOTEL ? 'HSH' : 'SH';

    const shiftNumber = await this.db.transaction(async (em) => {
      const [{ lock_key }] = await em.query(
        `SELECT abs(hashtext($1))::bigint AS lock_key`,
        [`shift_seq:${branchId}:${department}`],
      );
      await em.query(`SELECT pg_advisory_xact_lock($1)`, [lock_key]);
      const [{ count }] = await em.query(
        `SELECT COUNT(*)::int AS count FROM shifts WHERE branch_id = $1 AND tenant_id = $2 AND department = $3`,
        [branchId, tenantId, department],
      );
      return `${prefix}-${String(Number(count) + 1).padStart(4, '0')}`;
    });

    const shift = this.shiftRepo.create({
      tenantId,
      branchId,
      shiftNumber,
      department,
      openedBy:    userId,
      openingCash,
      status:      ShiftStatus.OPEN,
    });
    await this.shiftRepo.save(shift);

    if (denominations) {
      await this.denomRepo.save(
        this.denomRepo.create({ ...denominations, shiftId: shift.id, isOpening: true }),
      );
    }

    return this.enrichShift(shift);
  }

  async closeShift(
    shiftId: string,
    tenantId: string,
    userId: string,
    closingCash: number,
    denominations?: DenominationDto,
    notes?: string,
  ) {
    const shift = await this.shiftRepo.findOne({
      where: { id: shiftId, tenantId, status: ShiftStatus.OPEN },
    });
    if (!shift) throw new NotFoundException('Open shift not found');

    const expectedCash   = Number(shift.openingCash) + Number(shift.cashSales) - Number(shift.totalRefund);
    shift.status         = ShiftStatus.CLOSED;
    shift.closedBy       = userId;
    shift.closingCash    = closingCash;
    shift.expectedCash   = expectedCash;
    shift.cashDifference = closingCash - expectedCash;
    shift.closedAt       = new Date();
    if (notes !== undefined) shift.notes = notes;

    await this.shiftRepo.save(shift);

    if (denominations) {
      await this.denomRepo.save(
        this.denomRepo.create({ ...denominations, shiftId: shift.id, isOpening: false }),
      );
    }

    // Send shift summary email to owner/manager (non-blocking)
    this.sendShiftCloseEmail(shift).catch((err) =>
      this.logger.error(`Failed to send shift summary email: ${err.message}`),
    );

    return this.getShiftSummary(shift.id, tenantId);
  }

  async getActiveShift(
    branchId: string,
    tenantId: string,
    department: ShiftDepartment = ShiftDepartment.RESTAURANT,
  ) {
    const shift = await this.shiftRepo.findOne({
      where: { branchId, tenantId, status: ShiftStatus.OPEN, department },
      relations: ['denominations'],
    });
    if (!shift) return null;
    return this.enrichShift(shift);
  }

  async getShiftSummary(shiftId: string, tenantId: string) {
    const shift = await this.shiftRepo.findOne({
      where: { id: shiftId, tenantId },
      relations: ['denominations'],
    });
    if (!shift) throw new NotFoundException('Shift not found');

    const enriched = await this.enrichShift(shift);
    return {
      ...enriched,
      paymentBreakdown: {
        cash:          shift.cashSales,
        card:          shift.cardSales,
        upi:           shift.upiSales,
        wallet:        shift.walletSales,
        credit:        shift.creditSales,
        complimentary: shift.complimentary,
      },
      gstBreakdown: {
        cgst:  shift.totalCgst,
        sgst:  shift.totalSgst,
        igst:  shift.totalIgst,
        total: Number(shift.totalCgst) + Number(shift.totalSgst) + Number(shift.totalIgst),
      },
    };
  }

  async listShifts(
    branchId: string,
    tenantId: string,
    limit = 20,
    offset = 0,
    filters?: {
      status?: string;
      startDate?: string;
      endDate?: string;
      shiftNumber?: string;
    },
    department: ShiftDepartment = ShiftDepartment.RESTAURANT,
  ) {
    let sql = `
      SELECT
        s.*,
        u1.first_name AS opened_first_name,
        u1.last_name  AS opened_last_name,
        u1.role       AS opened_role,
        u2.first_name AS closed_first_name,
        u2.last_name  AS closed_last_name,
        u2.role       AS closed_role
      FROM shifts s
      LEFT JOIN users u1 ON u1.id = s.opened_by::uuid
      LEFT JOIN users u2 ON u2.id = s.closed_by::uuid
      WHERE s.branch_id = $1
        AND s.tenant_id = $2
        AND s.department = $3
    `;

    const params: any[] = [branchId, tenantId, department];
    let idx = 4;

    if (filters?.status) {
      sql += ` AND s.status = $${idx++}`;
      params.push(filters.status);
    }
    if (filters?.shiftNumber) {
      sql += ` AND s.shift_number ILIKE $${idx++}`;
      params.push(`%${filters.shiftNumber}%`);
    }
    if (filters?.startDate) {
      sql += ` AND s.opened_at >= $${idx++}`;
      params.push(new Date(filters.startDate));
    }
    if (filters?.endDate) {
      sql += ` AND s.opened_at <= $${idx++}`;
      params.push(new Date(filters.endDate));
    }

    sql += ` ORDER BY s.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const rows = await this.db.query(sql, params);
    return rows.map((r: any) => this.mapShiftRow(r));
  }

  async getShiftStats(
    branchId: string,
    tenantId: string,
    startDate?: Date,
    endDate?: Date,
    department: ShiftDepartment = ShiftDepartment.RESTAURANT,
  ) {
    const query = this.shiftRepo.createQueryBuilder('shift')
      .where('shift.branchId = :branchId', { branchId })
      .andWhere('shift.tenantId = :tenantId', { tenantId })
      .andWhere('shift.department = :department', { department })
      .andWhere('shift.status = :status', { status: ShiftStatus.CLOSED });

    if (startDate) query.andWhere('shift.closedAt >= :startDate', { startDate });
    if (endDate)   query.andWhere('shift.closedAt <= :endDate',   { endDate });

    const shifts = await query.getMany();

    const totalSales          = shifts.reduce((s, x) => s + Number(x.totalSales),     0);
    const totalCashDifference = shifts.reduce((s, x) => s + Number(x.cashDifference), 0);
    const averageShiftValue   = shifts.length > 0 ? totalSales / shifts.length : 0;

    return { totalShifts: shifts.length, totalSales, totalCashDifference, averageShiftValue };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async sendShiftCloseEmail(shift: Shift): Promise<void> {
    // 1. Fetch branch name
    const [branch] = await this.db.query(
      `SELECT name FROM branches WHERE id = $1`,
      [shift.branchId],
    );
    const branchName = branch?.name ?? 'Branch';

    // 2. Fetch opener & closer names
    const userIds = [shift.openedBy, shift.closedBy].filter(Boolean);
    const users: Array<{ id: string; first_name: string; last_name: string | null }> =
      userIds.length
        ? await this.db.query(
            `SELECT id, first_name, last_name FROM users WHERE id = ANY($1::uuid[])`,
            [userIds],
          )
        : [];
    const userMap = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name || ''}`.trim()]));

    // 3. Resolve email recipients: branch manager + owner
    const recipients: Array<{ email: string }> = await this.db.query(
      `SELECT DISTINCT email FROM users
       WHERE tenant_id = $1 AND is_active = true
         AND (role IN ('owner', 'manager')
           OR (branch_id = $2 AND role IN ('restaurant_manager', 'hotel_manager')))
         AND email IS NOT NULL`,
      [shift.tenantId, shift.branchId],
    );
    const toEmails = recipients.map((r) => r.email).filter(Boolean);
    if (!toEmails.length) return;

    await this.mailer.sendShiftSummary({
      to: toEmails,
      branchName,
      shiftNumber: shift.shiftNumber,
      openedBy: userMap.get(shift.openedBy) ?? 'Unknown',
      closedBy: userMap.get(shift.closedBy) ?? 'Unknown',
      openedAt: shift.createdAt,
      closedAt: shift.closedAt ?? new Date(),
      totalSales: Number(shift.totalSales),
      totalOrders: Number(shift.totalOrders),
      cashSales: Number(shift.cashSales),
      cardSales: Number(shift.cardSales),
      upiSales: Number(shift.upiSales),
      openingCash: Number(shift.openingCash),
      closingCash: Number(shift.closingCash ?? 0),
      expectedCash: Number(shift.expectedCash ?? 0),
      cashDifference: Number(shift.cashDifference ?? 0),
    });
  }

  private async enrichShift(shift: Shift): Promise<any> {
  const userIds = [shift.openedBy, shift.closedBy].filter(Boolean);
  if (!userIds.length) return shift;

  const users: Array<{
    id: string;
    first_name: string;
    last_name: string | null;
    role: string;
  }> = await this.db.query(
    `SELECT id, first_name, last_name, role FROM users WHERE id = ANY($1::uuid[])`,
    [userIds],
  );

  const userMap      = new Map(users.map((u) => [u.id, u]));
  const openedByUser = userMap.get(shift.openedBy);
  const closedByUser = userMap.get(shift.closedBy);

  return {
    ...shift,
    openedByUser: openedByUser
      ? {
          id:        openedByUser.id,
          firstName: openedByUser.first_name,
          lastName:  openedByUser.last_name,
          role:      openedByUser.role,
          fullName:  `${openedByUser.first_name} ${openedByUser.last_name || ''}`.trim(),
        }
      : null,
    closedByUser: closedByUser
      ? {
          id:        closedByUser.id,
          firstName: closedByUser.first_name,
          lastName:  closedByUser.last_name,
          role:      closedByUser.role,
          fullName:  `${closedByUser.first_name} ${closedByUser.last_name || ''}`.trim(),
        }
      : null,
  };
}

  private mapShiftRow(r: any) {
    return {
      id:            r.id,
      shiftNumber:   r.shift_number,
      status:        r.status,
      department:    r.department,
      openingCash:   r.opening_cash,
      closingCash:   r.closing_cash,
      expectedCash:  r.expected_cash,
      cashDifference: r.cash_difference,
      totalSales:    r.total_sales,
      totalOrders:   r.total_orders,
      cashSales:     r.cash_sales,
      cardSales:     r.card_sales,
      upiSales:      r.upi_sales,
      walletSales:   r.wallet_sales,
      creditSales:   r.credit_sales,
      complimentary: r.complimentary,
      totalRefund:   r.total_refund,
      totalCgst:     r.total_cgst,
      totalSgst:     r.total_sgst,
      totalIgst:     r.total_igst,
      notes:         r.notes,
      openedAt:      r.opened_at,
      closedAt:      r.closed_at,
      createdAt:     r.created_at,
      openedBy:      r.opened_by,
      closedBy:      r.closed_by,
      openedByUser: r.opened_first_name ? {
        firstName: r.opened_first_name,
        lastName:  r.opened_last_name,
        role:      r.opened_role,
        fullName:  `${r.opened_first_name} ${r.opened_last_name || ''}`.trim(),
      } : null,
      closedByUser: r.closed_first_name ? {
        firstName: r.closed_first_name,
        lastName:  r.closed_last_name,
        role:      r.closed_role,
        fullName:  `${r.closed_first_name} ${r.closed_last_name || ''}`.trim(),
      } : null,
    };
  }
}