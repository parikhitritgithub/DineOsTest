import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, Between, Like, ILike, In } from "typeorm";

import { RoomType } from "./entities/room-type.entity";
import { Room, RoomStatus } from "./entities/room.entity";
import { Guest } from "./entities/guest.entity";
import {
  Reservation,
  ReservationStatus,
  BookingSource,
} from "./entities/reservation.entity";
import { FolioCharge, ChargeType } from "./entities/folio-charge.entity";
import {
  HousekeepingTask,
  HkTaskType,
  HkStatus,
  HkPriority,
} from "./entities/housekeeping-task.entity";
import {
  Bill,
  InvoiceStatus,
  BillSource,
  GstType,
} from "../billing/entities/bill.entity";
import { Payment, PaymentMethod } from "../billing/entities/payment.entity";
import { Shift } from "../shifts/entities/shift.entity";
import { ChannelManagerService } from "./channel-manager.service";
import { MailerService } from "../mailer/mailer.service";
import { forwardRef, Inject } from "@nestjs/common";

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreateRoomTypeDto {
  branchId: string;
  name: string;
  description?: string;
  baseRate: number;
  maxOccupancy?: number;
  amenities?: string[];
}

export interface CreateRoomDto {
  roomTypeId: string;
  roomNumber: string;
  floor?: number;
  notes?: string;
}

export interface CreateGuestDto {
  name: string;
  phone: string;
  email?: string;
  idType?: string;
  idNumber?: string;
  nationality?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  dob?: string;
  gender?: string;
}

export interface CreateReservationDto {
  branchId: string;
  roomId: string;
  primaryGuestId?: string;
  guest?: CreateGuestDto; // create guest inline if no primaryGuestId
  numAdults?: number;
  numChildren?: number;
  checkInDate: string; // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  ratePerNight?: number; // if omitted, uses room type base rate
  advancePaid?: number;
  source?: BookingSource;
  bookingRef?: string;
  specialRequests?: string;
  notes?: string;
  createdById?: string;
}

export interface AddFolioChargeDto {
  description: string;
  amount: number;
  chargeType: ChargeType;
  referenceId?: string;
  date?: string;
}

export interface ListReservationsQuery {
  branchId?: string;
  status?: ReservationStatus;
  date?: string; // filter by check-in date
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class HotelService {
  constructor(
    @InjectRepository(RoomType)
    private readonly roomTypeRepo: Repository<RoomType>,
    @InjectRepository(Room) private readonly roomRepo: Repository<Room>,
    @InjectRepository(Guest) private readonly guestRepo: Repository<Guest>,
    @InjectRepository(Reservation)
    private readonly reservationRepo: Repository<Reservation>,
    @InjectRepository(FolioCharge)
    private readonly folioRepo: Repository<FolioCharge>,
    @InjectRepository(HousekeepingTask)
    private readonly hkRepo: Repository<HousekeepingTask>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @Inject(forwardRef(() => ChannelManagerService)) private readonly cmService: ChannelManagerService,
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) { }

  // ── Room Types ──────────────────────────────────────────────────────────────

  async createRoomType(
    tenantId: string,
    branchId: string,
    dto: CreateRoomTypeDto,
  ): Promise<RoomType> {
    const rt = this.roomTypeRepo.create({ tenantId, ...dto, branchId });
    return this.roomTypeRepo.save(rt);
  }

  listRoomTypes(tenantId: string, branchId?: string): Promise<RoomType[]> {
    const where: any = { tenantId, isActive: true };
    if (branchId) where.branchId = branchId;
    return this.roomTypeRepo.find({ where, order: { name: "ASC" } });
  }

  async updateRoomType(
    id: string,
    tenantId: string,
    data: Partial<RoomType>,
  ): Promise<RoomType> {
    const rt = await this.roomTypeRepo.findOne({ where: { id, tenantId } });
    if (!rt) throw new NotFoundException("Room type not found");
    Object.assign(rt, data);
    return this.roomTypeRepo.save(rt);
  }

  async deleteRoomType(id: string, tenantId: string): Promise<void> {
    const rt = await this.roomTypeRepo.findOne({ where: { id, tenantId } });
    if (!rt) throw new NotFoundException("Room type not found");
    rt.isActive = false;
    await this.roomTypeRepo.save(rt);
  }

  // ── Rooms ───────────────────────────────────────────────────────────────────

  async createRoom(
    tenantId: string,
    branchId: string,
    dto: CreateRoomDto,
  ): Promise<Room> {
    const exists = await this.roomRepo.findOne({
      where: { tenantId, branchId, roomNumber: dto.roomNumber },
    });
    if (exists)
      throw new ConflictException(
        `Room ${dto.roomNumber} already exists in this branch`,
      );

    const rt = await this.roomTypeRepo.findOne({
      where: { id: dto.roomTypeId, tenantId },
    });
    if (!rt) throw new NotFoundException("Room type not found");

    const room = this.roomRepo.create({
      tenantId,
      branchId,
      ...dto,
    });
    const saved = await this.roomRepo.save(room);

    // Update counter
    await this.roomTypeRepo.increment({ id: rt.id }, "totalRooms", 1);

    return saved;
  }

  async listRooms(
    tenantId: string,
    branchId?: string,
    status?: RoomStatus,
  ): Promise<Room[]> {
    console.log("TENANT ID:", tenantId);
    console.log("BRANCH ID:", branchId);
    console.log("STATUS:", status);

    const where: any = {
      tenantId,
      isActive: true,
    };

    if (branchId) where.branchId = branchId;
    if (status) where.status = status;

    console.log("WHERE:", where);

    const rooms = await this.roomRepo.find({
      where,
      relations: ["roomType"],
      order: {
        floor: "ASC",
        roomNumber: "ASC",
      },
    });

    console.log("ROOMS FOUND:", rooms);

    return rooms;
  }

  async updateRoom(
    id: string,
    tenantId: string,
    data: Partial<Room>,
  ): Promise<Room> {
    const room = await this.roomRepo.findOne({ where: { id, tenantId } });
    if (!room) throw new NotFoundException("Room not found");

    const statusChanged = data.status && data.status !== room.status;
    const newStatus = data.status;

    Object.assign(room, data);
    const savedRoom = await this.roomRepo.save(room);

    if (statusChanged && newStatus) {
      await this.syncHousekeepingOnStatusChange(id, tenantId, newStatus, room.branchId);
    }

    return savedRoom;
  }

  async updateRoomStatus(
    id: string,
    tenantId: string,
    status: RoomStatus,
  ): Promise<Room> {
    const room = await this.roomRepo.findOne({ where: { id, tenantId } });
    if (!room) throw new NotFoundException("Room not found");

    const statusChanged = status !== room.status;
    room.status = status;
    const savedRoom = await this.roomRepo.save(room);

    if (statusChanged) {
      await this.syncHousekeepingOnStatusChange(id, tenantId, status, room.branchId);
    }

    return savedRoom;
  }

  private async syncHousekeepingOnStatusChange(roomId: string, tenantId: string, status: RoomStatus, branchId: string) {
    if (status === RoomStatus.AVAILABLE) {
      const today = new Date().toISOString().split("T")[0];
      await this.hkRepo.update(
        {
          roomId,
          tenantId,
          scheduledFor: today,
          status: In([HkStatus.PENDING, HkStatus.IN_PROGRESS]),
        },
        {
          status: HkStatus.DONE,
          completedAt: new Date(),
          notes: "Auto-resolved via Room Status update",
        }
      );
    } else if (status === RoomStatus.CLEANING || status === RoomStatus.MAINTENANCE) {
      const today = new Date().toISOString().split("T")[0];
      const taskType = status === RoomStatus.CLEANING ? HkTaskType.STAYOVER : HkTaskType.MAINTENANCE;

      const existingTask = await this.hkRepo.findOne({
        where: {
          roomId,
          tenantId,
          scheduledFor: today,
          status: In([HkStatus.PENDING, HkStatus.IN_PROGRESS]),
        }
      });

      if (!existingTask) {
        const newTask = this.hkRepo.create({
          tenantId,
          branchId,
          roomId,
          taskType,
          status: HkStatus.PENDING,
          priority: HkPriority.NORMAL,
          scheduledFor: today,
          notes: `Auto-generated from room status update`,
        });
        await this.hkRepo.save(newTask);
      }
    }
  }

  // ── Guests ──────────────────────────────────────────────────────────────────

  async createGuest(tenantId: string, dto: CreateGuestDto): Promise<Guest> {
    const guest = this.guestRepo.create({ tenantId, ...dto } as Guest);
    return this.guestRepo.save(guest) as Promise<Guest>;
  }

  async searchGuests(tenantId: string, query: string): Promise<Guest[]> {
    if (!query || query.trim().length < 2) {
      return this.guestRepo.find({
        where: { tenantId },
        order: { createdAt: "DESC" },
        take: 20,
      });
    }
    const q = `%${query.trim()}%`;
    return this.guestRepo
      .createQueryBuilder("g")
      .where("g.tenant_id = :tenantId", { tenantId })
      .andWhere("(g.name ILIKE :q OR g.phone ILIKE :q OR g.email ILIKE :q)", {
        q,
      })
      .orderBy("g.total_stays", "DESC")
      .limit(20)
      .getMany() as Promise<Guest[]>;
  }

  getGuest(id: string, tenantId: string): Promise<Guest | null> {
    return this.guestRepo.findOne({ where: { id, tenantId } });
  }

  async updateGuest(
    id: string,
    tenantId: string,
    data: Partial<Guest>,
  ): Promise<Guest> {
    const guest = await this.guestRepo.findOne({ where: { id, tenantId } });
    if (!guest) throw new NotFoundException("Guest not found");
    Object.assign(guest, data);
    return this.guestRepo.save(guest);
  }

  // ── Reservations ────────────────────────────────────────────────────────────

  private calcNights(checkIn: string, checkOut: string): number {
    const msPerDay = 86_400_000;
    return Math.max(
      1,
      Math.round(
        (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / msPerDay,
      ),
    );
  }

  async createReservation(
    tenantId: string,
    branchId: string,
    dto: CreateReservationDto,
    userId?: string,
  ) {
    let bookedRoomTypeId: string | undefined;

    const result = await this.dataSource.transaction(async (em) => {
      // 1. Resolve or create guest
      let guestId = dto.primaryGuestId;
      if (!guestId && dto.guest) {
        const g = em.create(Guest, { tenantId, ...dto.guest } as any);
        const saved = await em.save(g);
        guestId = saved.id;
      }
      if (!guestId)
        throw new BadRequestException("Guest information is required");

      // 2. Validate room
      const room = await em.findOne(Room, {
        where: { id: dto.roomId, tenantId },
        relations: ["roomType"],
      });
      if (!room) throw new NotFoundException("Room not found");
      if (
        room.status === RoomStatus.MAINTENANCE ||
        room.status === RoomStatus.OUT_OF_ORDER
      ) {
        throw new BadRequestException(
          `Room ${room.roomNumber} is not available (${room.status})`,
        );
      }

      // 3. Check for overlapping reservations
      const overlap = await em
        .createQueryBuilder(Reservation, "r")
        .where("r.roomId = :roomId", { roomId: dto.roomId })
        .andWhere("r.status NOT IN (:...bad)", {
          bad: [
            ReservationStatus.CANCELLED,
            ReservationStatus.NO_SHOW,
            ReservationStatus.CHECKED_OUT,
          ],
        })
        .andWhere("r.checkInDate < :checkOut", { checkOut: dto.checkOutDate })
        .andWhere("r.checkOutDate > :checkIn", { checkIn: dto.checkInDate })
        .getOne();
      if (overlap)
        throw new ConflictException(
          `Room ${room.roomNumber} is already booked for the selected dates`,
        );
      // 4. Validate dates
      const checkIn = new Date(dto.checkInDate);
      const checkOut = new Date(dto.checkOutDate);

      if (checkOut <= checkIn) {
        throw new BadRequestException(
          "Check-out date must be after check-in date",
        );
      }
      // 4. Calculate financials
      const numNights = this.calcNights(dto.checkInDate, dto.checkOutDate);
      const rate = dto.ratePerNight ?? Number(room.roomType?.baseRate ?? 0);
      const subtotal = rate * numNights;
      const taxRate = 0.12; // 12% GST on accommodation
      const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
      const totalAmount = subtotal + taxAmount;
      const advancePaid = dto.advancePaid ?? 0;
      const balanceDue = totalAmount - advancePaid;

      // 5. Create reservation
      const reservation = em.create(Reservation, {
        tenantId,
        branchId,
        roomId: dto.roomId,
        primaryGuestId: guestId,
        numAdults: dto.numAdults ?? 1,
        numChildren: dto.numChildren ?? 0,
        checkInDate: dto.checkInDate,
        checkOutDate: dto.checkOutDate,
        status: ReservationStatus.CONFIRMED,
        ratePerNight: rate,
        numNights,
        subtotal,
        taxAmount,
        totalAmount,
        advancePaid,
        balanceDue,
        source: dto.source ?? BookingSource.WALK_IN,
        bookingRef: dto.bookingRef,
        specialRequests: dto.specialRequests,
        notes: dto.notes,
        createdById: userId,
      });
      const saved = await em.save(reservation);

      // 6. Mark room as reserved
      await em.update(
        Room,
        { id: dto.roomId },
        { status: RoomStatus.RESERVED },
      );

      // 7. Create advance folio entry if advance paid
      if (advancePaid > 0) {
        const charge = em.create(FolioCharge, {
          tenantId,
          reservationId: saved.id,
          description: "Advance payment",
          amount: -advancePaid,
          chargeType: ChargeType.ADVANCE,
          date: new Date().toISOString().split("T")[0],
        });
        await em.save(charge);
      }

      return em.findOne(Reservation, {
        where: { id: saved.id },
        relations: ["room", "room.roomType", "primaryGuest"],
      });
    });
  }

  async listReservations(tenantId: string, query: ListReservationsQuery) {
    const { branchId, status, from, to, search, page = 1, limit = 50 } = query;

    const qb = this.reservationRepo
      .createQueryBuilder("r")
      .leftJoinAndSelect("r.room", "room")
      .leftJoinAndSelect("room.roomType", "roomType")
      .leftJoinAndSelect("r.primaryGuest", "guest")
      .where("r.tenantId = :tenantId", { tenantId });

    if (branchId) qb.andWhere("r.branchId = :branchId", { branchId });
    if (status) qb.andWhere("r.status = :status", { status });
    if (from) qb.andWhere("r.checkInDate >= :from", { from });
    if (to) qb.andWhere("r.checkOutDate <= :to", { to });
    if (search) {
      qb.andWhere(
        "(guest.name ILIKE :s OR guest.phone ILIKE :s OR room.roomNumber ILIKE :s OR r.bookingRef ILIKE :s)",
        { s: `%${search}%` },
      );
    }

    console.log(qb.getSql());

    const [data, total] = await qb
      .orderBy("r.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async getReservation(id: string, tenantId: string): Promise<Reservation> {
    const r = await this.reservationRepo.findOne({
      where: { id, tenantId },
      relations: ["room", "room.roomType", "primaryGuest"],
    });
    if (!r) throw new NotFoundException("Reservation not found");
    return r;
  }

  async checkIn(id: string, tenantId: string): Promise<Reservation> {
    const r = await this.reservationRepo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException("Reservation not found");
    if (r.status !== ReservationStatus.CONFIRMED) {
      throw new BadRequestException(
        `Cannot check in — reservation status is ${r.status}`,
      );
    }

    await this.dataSource.transaction(async (em) => {
      // Update reservation
      await em.update(
        Reservation,
        { id },
        {
          status: ReservationStatus.CHECKED_IN,
          actualCheckIn: new Date(),
        },
      );
      // Mark room occupied
      await em.update(Room, { id: r.roomId }, { status: RoomStatus.OCCUPIED });

      // Room charges are dynamically injected in getFolio, so we don't post a partial charge here
    });

    return this.getReservation(id, tenantId);
  }

  async checkOut(id: string, tenantId: string): Promise<Reservation> {
    const r = await this.reservationRepo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException("Reservation not found");
    if (r.status !== ReservationStatus.CHECKED_IN) {
      throw new BadRequestException(
        `Cannot check out — reservation status is ${r.status}`,
      );
    }

    await this.dataSource.transaction(async (em) => {
      await em.update(
        Reservation,
        { id },
        {
          status: ReservationStatus.CHECKED_OUT,
          actualCheckOut: new Date(),
        },
      );
      // Mark room as needing cleaning
      await em.update(Room, { id: r.roomId }, { status: RoomStatus.CLEANING });

      // Increment guest stay counter
      await em.increment(Guest, { id: r.primaryGuestId }, "totalStays", 1);

      // Auto-create housekeeping task
      const task = em.create(HousekeepingTask, {
        tenantId,
        branchId: r.branchId,
        roomId: r.roomId,
        reservationId: id,
        taskType: HkTaskType.CHECKOUT_CLEAN,
        status: HkStatus.PENDING,
        priority: HkPriority.HIGH,
        scheduledFor: new Date().toISOString().split("T")[0],
      });
      await em.save(task);
    });

    // Send checkout confirmation email if guest has email (non-blocking)
    this.sendCheckoutEmail(id, tenantId).catch(() => {});

    return this.getReservation(id, tenantId);
  }

  async cancelReservation(
    id: string,
    tenantId: string,
    reason: string,
  ): Promise<Reservation> {
    const r = await this.reservationRepo.findOne({ 
      where: { id, tenantId },
      relations: ["room", "room.roomType"]
    });
    if (!r) throw new NotFoundException("Reservation not found");
    if (
      [ReservationStatus.CHECKED_OUT, ReservationStatus.CANCELLED].includes(
        r.status,
      )
    ) {
      throw new BadRequestException(`Reservation is already ${r.status}`);
    }

    await this.dataSource.transaction(async (em) => {
      await em.update(
        Reservation,
        { id },
        {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      );
      // Free the room back to available (only if it was reserved, not occupied)
      if (r.status === ReservationStatus.CONFIRMED) {
        await em.update(
          Room,
          { id: r.roomId },
          { status: RoomStatus.AVAILABLE },
        );
      }
    });

    if (r.room?.roomType?.id && r.branchId) {
      this.cmService.syncInventoryOutbound(tenantId, r.branchId, r.room.roomType.id).catch((err) => console.error(err));
    }

    return this.getReservation(id, tenantId);
  }

  // ── Folio ───────────────────────────────────────────────────────────────────

  async getFolio(reservationId: string, tenantId: string) {
    const r = await this.reservationRepo.findOne({
      where: { id: reservationId, tenantId },
      relations: ["room", "room.roomType", "primaryGuest"],
    });
    if (!r) throw new NotFoundException("Reservation not found");

    const dbCharges = await this.folioRepo.find({
      where: { reservationId, tenantId },
      order: { createdAt: "ASC" },
    });

    // Remove any legacy hardcoded ROOM_CHARGEs from the DB so we don't double charge
    const extraCharges = dbCharges.filter(
      (c) => c.chargeType !== ChargeType.ROOM_CHARGE,
    );

    const injectedCharges: FolioCharge[] = [
      {
        id: "room-charge",
        tenantId,
        reservationId,
        description: `Room Charges (${r.numNights} Nights)`,
        amount: Number(r.subtotal),
        chargeType: ChargeType.ROOM_CHARGE,
        date: r.checkInDate,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as FolioCharge,
      {
        id: "room-tax",
        tenantId,
        reservationId,
        description: "Taxes (Accommodation)",
        amount: Number(r.taxAmount),
        chargeType: ChargeType.SERVICE,
        date: r.checkInDate,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as FolioCharge,
    ];

    const charges = [...injectedCharges, ...extraCharges];

    const totalCharges = charges
      .filter((c) => Number(c.amount) > 0)
      .reduce((s, c) => s + Number(c.amount), 0);

    const totalPaid = charges
      .filter((c) => Number(c.amount) < 0)
      .reduce((s, c) => s + Math.abs(Number(c.amount)), 0);

    const balance = totalCharges - totalPaid;

    return { reservation: r, charges, totalCharges, totalPaid, balance };
  }

  async addFolioCharge(
    reservationId: string,
    tenantId: string,
    dto: AddFolioChargeDto,
  ) {
    const r = await this.reservationRepo.findOne({
      where: { id: reservationId, tenantId },
    });
    if (!r) throw new NotFoundException("Reservation not found");

    const charge = this.folioRepo.create({
      tenantId,
      reservationId,
      description: dto.description,
      amount:
        dto.chargeType === ChargeType.ADVANCE ||
          dto.chargeType === ChargeType.DISCOUNT
          ? -Math.abs(dto.amount) // credits are stored as negative
          : dto.amount,
      chargeType: dto.chargeType,
      referenceId: dto.referenceId,
      date: dto.date ?? new Date().toISOString().split("T")[0],
    });
    return this.folioRepo.save(charge);
  }

  // ── Billing ─────────────────────────────────────────────────────────────────

  async generateBill(
    reservationId: string,
    tenantId: string,
    paymentMethod: PaymentMethod = PaymentMethod.CASH,
    amountPaid: number = 0,
    shiftId?: string,
  ) {
    const { reservation, charges, balance } = await this.getFolio(
      reservationId,
      tenantId,
    );

    const existing = await this.billRepo.findOne({
      where: { reservationId, tenantId },
    });
    if (existing)
      throw new ConflictException(
        "Bill already generated for this reservation",
      );

    // Filter to only positive charges to calculate total owed
    const debitCharges = charges.filter((c) => c.amount > 0);
    const grandTotal = debitCharges.reduce(
      (sum, c) => sum + Number(c.amount),
      0,
    );
    // Already paid via advances
    const advances = charges
      .filter((c) => c.chargeType === ChargeType.ADVANCE)
      .reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);

    // For simplicity, we keep taxes as what was calculated on the room
    const totalTax = Number(reservation.taxAmount);
    const subtotal = grandTotal - totalTax;

    return this.dataSource.transaction(async (em) => {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const [{ lock_key }] = await em.query(
        `SELECT abs(hashtext($1))::bigint AS lock_key`,
        [`bill_seq:${reservation.branchId}`],
      );
      await em.query(`SELECT pg_advisory_xact_lock($1)`, [lock_key]);
      const [{ count }] = await em.query(
        `SELECT COUNT(*)::int AS count FROM bills WHERE branch_id = $1`,
        [reservation.branchId],
      );
      const billNumber = `BILL-${today}-${String(Number(count) + 1).padStart(5, "0")}`;

      const totalPaidNow = advances + amountPaid;

      const bill = em.create(Bill, {
        tenantId,
        branchId: reservation.branchId,
        reservationId,
        shiftId: shiftId || undefined,
        source: BillSource.HOTEL,
        billNumber,
        invoiceNumber: billNumber,
        status:
          grandTotal - totalPaidNow <= 0.01
            ? InvoiceStatus.PAID
            : InvoiceStatus.ISSUED,
        customerName: reservation.primaryGuest.name,
        customerPhone: reservation.primaryGuest.phone,
        supplyType: GstType.CGST_SGST,
        subtotal: subtotal,
        taxableAmount: subtotal,
        cgstAmount: totalTax / 2,
        sgstAmount: totalTax / 2,
        igstAmount: 0,
        cessAmount: 0,
        totalTax: totalTax,
        grandTotal: grandTotal,
        paidAmount: totalPaidNow,
        changeAmount: Math.max(0, totalPaidNow - grandTotal),
        notes: `Hotel Bill for Room ${reservation.room.roomNumber}`,
      });
      await em.save(bill);

      // Record the new payment if any
      if (amountPaid > 0) {
        const payment = em.create(Payment, {
          tenantId,
          branchId: reservation.branchId,
          billId: bill.id,
          shiftId: shiftId || undefined,
          method: paymentMethod,
          amount: amountPaid,
        });
        await em.save(payment);

        const charge = em.create(FolioCharge, {
          tenantId,
          reservationId,
          description: "Bill Settlement",
          amount: -Math.abs(amountPaid),
          chargeType: ChargeType.SETTLEMENT,
          date: new Date().toISOString().split("T")[0],
        });
        await em.save(charge);
      }

      // Record advances as payments linked to this bill
      if (advances > 0) {
        const advPayment = em.create(Payment, {
          tenantId,
          branchId: reservation.branchId,
          billId: bill.id,
          shiftId: shiftId || undefined,
          method: PaymentMethod.CASH, // Defaulting advance to cash for now
          amount: advances,
          referenceNo: "Advance",
        });
        await em.save(advPayment);
      }

      // ── Update shift totals if a shift is active ────────────────────────
      if (shiftId) {
        await this.updateHotelShiftTotals(shiftId, bill, paymentMethod, amountPaid, advances, em);
      }

      return bill;
    });
  }

  /**
   * Update shift running totals when a hotel bill is generated.
   * Mirrors restaurant BillingService.updateShiftTotals().
   */
  private async updateHotelShiftTotals(
    shiftId: string,
    bill: Bill,
    paymentMethod: PaymentMethod,
    amountPaid: number,
    advances: number,
    em: any,
  ) {
    const shift = await em.findOne(Shift, { where: { id: shiftId } });
    if (!shift) return;

    shift.totalSales  = Number(shift.totalSales  || 0) + Number(bill.grandTotal);
    shift.totalOrders = Number(shift.totalOrders || 0) + 1;

    // Track the new payment by method
    if (amountPaid > 0) {
      switch (paymentMethod) {
        case PaymentMethod.CASH:          shift.cashSales     = Number(shift.cashSales     || 0) + amountPaid; break;
        case PaymentMethod.CARD:          shift.cardSales     = Number(shift.cardSales     || 0) + amountPaid; break;
        case PaymentMethod.UPI:           shift.upiSales      = Number(shift.upiSales      || 0) + amountPaid; break;
        case PaymentMethod.WALLET:        shift.walletSales   = Number(shift.walletSales   || 0) + amountPaid; break;
        case PaymentMethod.CREDIT:        shift.creditSales   = Number(shift.creditSales   || 0) + amountPaid; break;
        case PaymentMethod.COMPLIMENTARY: shift.complimentary = Number(shift.complimentary || 0) + amountPaid; break;
      }
    }

    // Advances are tracked as cash by default
    if (advances > 0) {
      shift.cashSales = Number(shift.cashSales || 0) + advances;
    }

    // Update GST totals
    shift.totalCgst = Number(shift.totalCgst || 0) + Number(bill.cgstAmount);
    shift.totalSgst = Number(shift.totalSgst || 0) + Number(bill.sgstAmount);
    shift.totalIgst = Number(shift.totalIgst || 0) + Number(bill.igstAmount);

    await em.save(shift);
  }

  // ── Reports ─────────────────────────────────────────────────────────────────

  async getRevenueReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      DATE(r.check_in_date)           AS date,
      COUNT(r.id)::int                AS bookings,
      COALESCE(SUM(r.total_amount),0) AS revenue,
      COALESCE(SUM(r.tax_amount),0)   AS tax,
      COALESCE(SUM(r.total_amount - r.tax_amount),0) AS net_revenue
    FROM hotel_reservations r
    WHERE r.tenant_id  = $1
      AND r.branch_id  = $2
      AND r.status     NOT IN ('cancelled','no_show')
      AND r.check_in_date BETWEEN $3 AND $4
    GROUP BY DATE(r.check_in_date)
    ORDER BY DATE(r.check_in_date)
    `,
      [tenantId, branchId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
  }

  async getBookingsReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      r.id                                        AS booking_id,
      r.booking_ref                               AS booking_ref,
      g.name                                      AS guest_name,
      g.email                                     AS guest_email,
      g.phone                                     AS guest_phone,
      rm.room_number,
      r.check_in_date                             AS check_in,
      r.check_out_date                            AS check_out,
      r.num_nights                                AS nights,
      r.status,
      r.total_amount                              AS amount,
      r.balance_due,
      COALESCE(b.status::text, 'unpaid')          AS payment_status
    FROM hotel_reservations r
    LEFT JOIN hotel_guests   g  ON g.id  = r.primary_guest_id
    LEFT JOIN hotel_rooms    rm ON rm.id = r.room_id
    LEFT JOIN bills          b  ON b.reservation_id = r.id
    WHERE r.tenant_id  = $1
      AND r.branch_id  = $2
      AND r.check_in_date BETWEEN $3 AND $4
    ORDER BY r.check_in_date DESC
    `,
      [tenantId, branchId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
  }

  async getRoomsPerformanceReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      rm.room_number,
      rt.name                                              AS room_type,
      COUNT(r.id)::int                                     AS bookings,
      COALESCE(
        ROUND(
          COUNT(r.id)::numeric /
          NULLIF(($4::date - $3::date + 1), 0) * 100
        ,0),0)::int                                        AS occupancy,
      COALESCE(SUM(r.total_amount),0)                      AS revenue,
      COALESCE(ROUND(AVG(r.rate_per_night)::numeric,2),0)  AS avg_rate
    FROM hotel_rooms rm
    LEFT JOIN hotel_room_types rt ON rt.id = rm.room_type_id
    LEFT JOIN hotel_reservations r
      ON r.room_id   = rm.id
     AND r.status   NOT IN ('cancelled','no_show')
     AND r.check_in_date BETWEEN $3 AND $4
    WHERE rm.tenant_id = $1
      AND rm.branch_id = $2
      AND rm.is_active = true
    GROUP BY rm.id, rm.room_number, rt.name
    ORDER BY revenue DESC
    `,
      [tenantId, branchId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
  }

  async getOccupancySummary(tenantId: string, branchId: string) {
    const rows = await this.dataSource.query(
      `
    SELECT
      COUNT(*)::int                                                      AS total_rooms,
      COUNT(*) FILTER (WHERE status = 'occupied')::int                  AS occupied_rooms,
      COUNT(*) FILTER (WHERE status = 'available')::int                 AS available_rooms,
      COUNT(*) FILTER (WHERE status IN ('maintenance','out_of_order'))::int AS maintenance_rooms,
      COALESCE(ROUND(
        COUNT(*) FILTER (WHERE status = 'occupied')::numeric /
        NULLIF(COUNT(*),0) * 100
      ,0),0)::int                                                        AS occupancy_today
    FROM hotel_rooms
    WHERE tenant_id = $1
      AND branch_id = $2
      AND is_active = true
    `,
      [tenantId, branchId],
    );
    return rows[0] ?? {
      total_rooms: 0,
      occupied_rooms: 0,
      available_rooms: 0,
      maintenance_rooms: 0,
      occupancy_today: 0,
    };
  }

  async getPaymentsReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      p.method,
      COUNT(p.id)::int                 AS transaction_count,
      COALESCE(SUM(p.amount),0)        AS total_amount
    FROM payments p
    JOIN bills b ON b.id = p.bill_id
    WHERE p.tenant_id  = $1
      AND b.branch_id  = $2
      AND p.created_at BETWEEN $3 AND $4
    GROUP BY p.method
    ORDER BY total_amount DESC
    `,
      [tenantId, branchId, from, to],
    );
  }

  async getGstReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      TO_CHAR(DATE_TRUNC('month', r.check_in_date::date), 'YYYY-MM-DD') AS month,
      COUNT(r.id)::int                                                    AS total_invoices,
      COALESCE(SUM(r.total_amount - r.tax_amount),0)                      AS taxable_value,
      COALESCE(SUM(r.tax_amount / 2),0)                                   AS cgst,
      COALESCE(SUM(r.tax_amount / 2),0)                                   AS sgst,
      0                                                                    AS igst,
      COALESCE(SUM(r.tax_amount),0)                                        AS total_tax,
      COALESCE(SUM(r.total_amount),0)                                      AS gross_value
    FROM hotel_reservations r
    WHERE r.tenant_id  = $1
      AND r.branch_id  = $2
      AND r.status     NOT IN ('cancelled','no_show')
      AND r.check_in_date BETWEEN $3 AND $4
    GROUP BY DATE_TRUNC('month', r.check_in_date::date)
    ORDER BY DATE_TRUNC('month', r.check_in_date::date)
    `,
      [tenantId, branchId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
  }

  async getFrontDeskReport(tenantId: string, branchId: string, from: Date, to: Date) {
    return this.dataSource.query(
      `
    SELECT
      u.id                                           AS staff_id,
      CONCAT(u.first_name, ' ', COALESCE(u.last_name, '')) AS staff_name,
      COUNT(r.id) FILTER (WHERE r.actual_check_in  IS NOT NULL)::int AS check_ins,
      COUNT(r.id) FILTER (WHERE r.actual_check_out IS NOT NULL)::int AS check_outs,
      COUNT(r.id)::int                               AS bookings_handled,
      COALESCE(SUM(r.total_amount),0)                AS revenue_managed,
      COALESCE(ROUND(AVG(r.total_amount)::numeric,2),0) AS avg_booking_value
    FROM hotel_reservations r
    JOIN users u ON u.id = r.created_by_id
    WHERE r.tenant_id  = $1
      AND r.branch_id  = $2
      AND r.status     NOT IN ('cancelled','no_show')
      AND r.check_in_date BETWEEN $3 AND $4
    GROUP BY u.id, u.first_name, u.last_name
    ORDER BY revenue_managed DESC
    `,
      [tenantId, branchId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
  }

  async getGstr1Export(tenantId: string, branchId: string, from: Date, to: Date) {
    const gstData = await this.getGstReport(tenantId, branchId, from, to);

    // Transform to GSTR-1 format
    const gstr1Data = {
      version: '1.0',
      gstin: process.env.GSTIN || 'GSTIN_NUMBER',
      fp: `${from.getFullYear()}${String(from.getMonth() + 1).padStart(2, '0')}`,
      b2b: gstData.map((invoice: any) => ({
        ctin: invoice.gstin || 'NA',
        cfs: 'N',
        inv: [{
          inum: invoice.invoice_number || `INV-${invoice.month}`,
          idt: invoice.month,
          val: Math.round(invoice.gross_value * 100) / 100,
          inv_typ: 'R',
          pos: 'NA',
          rchrg: 'N',
          itms: [{
            num: 1,
            itm_det: {
              txval: Math.round(invoice.taxable_value * 100) / 100,
              irate: Math.round((invoice.total_tax / invoice.taxable_value) * 10000) / 100,
              camt: Math.round(invoice.cgst * 100) / 100,
              samt: Math.round(invoice.sgst * 100) / 100,
              iamt: Math.round(invoice.igst * 100) / 100,
              csamt: 0,
            },
            itc: {
              elg: 'N',
              txval: 0,
              irate: 0,
              camt: 0,
              samt: 0,
              iamt: 0,
            }
          }]
        }]
      })),
      b2cl: [],
      b2cs: [],
      cdnr: [],
      cdnur: [],
      hsn: [],
      nil: [],
      exp: [],
      txpd: []
    };

    return gstr1Data;
  }
  // ── Housekeeping ────────────────────────────────────────────────────────────

  async listHousekeepingTasks(
    tenantId: string,
    branchId?: string,
    date?: string,
  ) {
    const where: any = { tenantId };
    if (branchId) where.branchId = branchId;
    where.scheduledFor = date ?? new Date().toISOString().split("T")[0];
    return this.hkRepo.find({
      where,
      relations: ['room', 'room.roomType'],
      order: { priority: "DESC", createdAt: "ASC" },
    });
  }

  async updateHousekeepingTask(
    id: string,
    tenantId: string,
    status: HkStatus,
    notes?: string,
  ) {
    const task = await this.hkRepo.findOne({ where: { id, tenantId } });
    if (!task) throw new NotFoundException("Task not found");

    task.status = status;
    if (notes) task.notes = notes;
    if (status === HkStatus.IN_PROGRESS && !task.startedAt)
      task.startedAt = new Date();
    if (status === HkStatus.DONE && !task.completedAt)
      task.completedAt = new Date();

    const saved = await this.hkRepo.save(task);

    // When cleaning is done → mark room available
    if (
      status === HkStatus.DONE &&
      task.taskType === HkTaskType.CHECKOUT_CLEAN
    ) {
      await this.roomRepo.update(
        { id: task.roomId, tenantId },
        { status: RoomStatus.AVAILABLE },
      );
    }

    return saved;
  }

  async createHousekeepingTask(
    tenantId: string,
    branchId: string,
    dto: {
      roomId: string;
      taskType: HkTaskType;
      priority?: HkPriority;
      scheduledFor?: string;
      notes?: string;
      assignedTo?: string;
    },
  ) {
    const task = this.hkRepo.create({
      tenantId,
      branchId,
      roomId: dto.roomId,
      taskType: dto.taskType,
      priority: dto.priority ?? HkPriority.NORMAL,
      scheduledFor: dto.scheduledFor ?? new Date().toISOString().split("T")[0],
      notes: dto.notes,
      assignedTo: dto.assignedTo,
      status: HkStatus.PENDING,
    });
    return this.hkRepo.save(task);
  }

  // ── Dashboard summary ────────────────────────────────────────────────────────

  async getDashboard(tenantId: string, branchId?: string) {
    const today = new Date().toISOString().split("T")[0];

    const roomsQuery = this.roomRepo
      .createQueryBuilder("r")
      .where("r.tenantId = :tenantId AND r.isActive = true", { tenantId });
    if (branchId) roomsQuery.andWhere("r.branchId = :branchId", { branchId });

    const rooms = await roomsQuery.getMany();

    const byStatus = rooms.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    const [arrivalsToday, departuresToday, inHouse] = await Promise.all([
      this.reservationRepo.count({
        where: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          checkInDate: today,
          status: ReservationStatus.CONFIRMED,
        },
      }),
      this.reservationRepo.count({
        where: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          checkOutDate: today,
          status: ReservationStatus.CHECKED_IN,
        },
      }),
      this.reservationRepo.count({
        where: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          status: ReservationStatus.CHECKED_IN,
        },
      }),
    ]);

    const totalRooms = rooms.length;
    const occupancyPct =
      totalRooms > 0
        ? Math.round(((byStatus[RoomStatus.OCCUPIED] ?? 0) / totalRooms) * 100)
        : 0;

    return {
      totalRooms,
      occupancyPct,
      roomsByStatus: byStatus,
      arrivalsToday,
      departuresToday,
      inHouse,
    };
  }

  // ── Email Helpers ──────────────────────────────────────────────────────────

  private async sendCheckoutEmail(reservationId: string, tenantId: string): Promise<void> {
    const reservation = await this.reservationRepo.findOne({
      where: { id: reservationId, tenantId },
      relations: ['room', 'room.roomType', 'primaryGuest'],
    });
    if (!reservation?.primaryGuest?.email) return;

    const branch = await this.dataSource.query(
      `SELECT name FROM branches WHERE id = $1`,
      [reservation.branchId],
    );

    await this.mailer.sendCheckoutConfirmation({
      to: reservation.primaryGuest.email,
      guestName: reservation.primaryGuest.name,
      roomNumber: reservation.room?.roomNumber ?? 'N/A',
      roomType: reservation.room?.roomType?.name ?? 'Standard',
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      numNights: reservation.numNights,
      totalAmount: Number(reservation.totalAmount),
      branchName: branch?.[0]?.name ?? 'Our Hotel',
    });
  }
}
