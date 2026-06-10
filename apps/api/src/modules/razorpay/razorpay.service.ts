import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
const Razorpay = require('razorpay');
import { Subscription, SubscriptionStatus } from '../subscriptions/entities/subscription.entity';
import { Plan } from '../subscriptions/entities/plan.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { MailerService } from '../mailer/mailer.service';

@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Subscription) private readonly subRepo: Repository<Subscription>,
    @InjectRepository(Plan) private readonly planRepo: Repository<Plan>,
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    private readonly mailer: MailerService,
  ) {}

  private async getClientInfo(): Promise<{ client: any | null; webhookSecret: string; keyId: string }> {
    const sysTenant = await this.tenantRepo.findOne({ where: { slug: '_system' } });
    const settings = sysTenant?.settings || {};

    const keyId = settings.razorpayKeyId || this.config.get('RAZORPAY_KEY_ID', '');
    const keySecret = settings.razorpayKeySecret || this.config.get('RAZORPAY_KEY_SECRET', '');
    const webhookSecret = settings.razorpayWebhookSecret || this.config.get('RAZORPAY_WEBHOOK_SECRET', '');

    let client: any | null = null;
    if (keyId && keySecret && !keyId.includes('xxxxx')) {
      client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }

    return { client, webhookSecret, keyId };
  }

  // ─── Create a Razorpay subscription for a tenant ─────────────────────────

  async createSubscription(tenantId: string, planCode: string, frequency: 'monthly' | 'yearly' = 'monthly') {
    const { client, keyId } = await this.getClientInfo();
    if (!client) throw new BadRequestException('Razorpay not configured');

    const plan = await this.planRepo.findOne({ where: { code: planCode } });
    if (!plan) throw new BadRequestException('Plan not found');

    const amount = frequency === 'yearly'
      ? Number(plan.priceAnnual) * 100
      : Number(plan.priceMonthly) * 100;

    // Create Razorpay order (subscription-style one-time or recurring)
    const order = await (client as any).orders.create({
      amount: Math.round(amount),
      currency: 'INR',
      receipt: `sub_${tenantId.slice(0, 8)}_${Date.now()}`,
      notes: { tenantId, planCode, frequency },
    });

    this.logger.log(`Razorpay order created: ${order.id} for tenant ${tenantId}`);
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
    };
  }

  // ─── Verify payment signature after frontend checkout ────────────────────

  async verifyPaymentSignature(opts: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): Promise<boolean> {
    const sysTenant = await this.tenantRepo.findOne({ where: { slug: '_system' } });
    const keySecret = sysTenant?.settings?.razorpayKeySecret || this.config.get('RAZORPAY_KEY_SECRET', '');

    const body = `${opts.orderId}|${opts.paymentId}`;
    const expectedSig = crypto
      .createHmac('sha256', keySecret)
      .update(body)
      .digest('hex');
    return expectedSig === opts.signature;
  }

  // ─── Activate subscription after verified payment ────────────────────────

  async activateSubscription(opts: {
    tenantId: string;
    planCode: string;
    frequency: 'monthly' | 'yearly';
    razorpayPaymentId: string;
    razorpayOrderId: string;
  }): Promise<Subscription> {
    const plan = await this.planRepo.findOne({ where: { code: opts.planCode } });
    if (!plan) throw new BadRequestException('Plan not found');

    const now = new Date();
    const periodEnd = new Date(now);
    if (opts.frequency === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    let sub = await this.subRepo.findOne({ where: { tenantId: opts.tenantId } });
    if (sub) {
      sub.status = SubscriptionStatus.ACTIVE;
      sub.planId = plan.id;
      sub.currentPeriodStart = now;
      sub.currentPeriodEnd = periodEnd;
      sub.razorpaySubId = opts.razorpayPaymentId;
      sub.metadata = { ...sub.metadata, lastPaymentId: opts.razorpayPaymentId, lastOrderId: opts.razorpayOrderId };
    } else {
      sub = this.subRepo.create({
        tenantId: opts.tenantId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        razorpaySubId: opts.razorpayPaymentId,
        metadata: { lastPaymentId: opts.razorpayPaymentId, lastOrderId: opts.razorpayOrderId },
      });
    }

    await this.subRepo.save(sub);
    this.logger.log(`Subscription activated for tenant ${opts.tenantId} — plan ${opts.planCode}`);

    // Send subscription activation confirmation email (non-blocking)
    this.sendActivationEmail(opts.tenantId, plan, sub.currentPeriodEnd).catch((err) =>
      this.logger.error(`Failed to send activation email: ${err.message}`),
    );

    return sub;
  }

  private async sendActivationEmail(tenantId: string, plan: Plan, nextBillingDate: Date): Promise<void> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant?.email) return;

    await this.mailer.sendSubscriptionActivated({
      to: tenant.email,
      businessName: tenant.name,
      planName: plan.name,
      priceMonthly: Number(plan.priceMonthly),
      nextBillingDate,
    });
  }

  // ─── Process Razorpay webhooks ────────────────────────────────────────────

  async handleWebhook(rawBody: Buffer, signature: string): Promise<{ processed: boolean; event: string }> {
    const { webhookSecret } = await this.getClientInfo();

    // Always verify webhook authenticity — no bypass allowed.
    if (!webhookSecret || webhookSecret === 'xxxxx') {
      this.logger.error('RAZORPAY_WEBHOOK_SECRET is not configured — rejecting webhook');
      throw new BadRequestException('Webhook endpoint is not configured.');
    }

    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (expectedSig !== signature) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString());
    const eventType: string = event.event;
    this.logger.log(`Razorpay webhook received: ${eventType}`);

    switch (eventType) {
      case 'payment.captured':
        await this.onPaymentCaptured(event.payload.payment.entity);
        break;
      case 'payment.failed':
        await this.onPaymentFailed(event.payload.payment.entity);
        break;
      case 'subscription.activated':
        await this.onSubscriptionActivated(event.payload.subscription.entity);
        break;
      case 'subscription.charged':
        await this.onSubscriptionCharged(event.payload.subscription.entity);
        break;
      case 'subscription.cancelled':
        await this.onSubscriptionCancelled(event.payload.subscription.entity);
        break;
      case 'subscription.halted':
        await this.onSubscriptionHalted(event.payload.subscription.entity);
        break;
      default:
        this.logger.log(`Unhandled Razorpay event: ${eventType}`);
    }

    return { processed: true, event: eventType };
  }

  private async onPaymentCaptured(payment: any) {
    const { tenantId, planCode, frequency } = payment.notes || {};
    if (!tenantId || !planCode) return;

    await this.activateSubscription({
      tenantId,
      planCode,
      frequency: frequency || 'monthly',
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id,
    });
  }

  private async onPaymentFailed(payment: any) {
    const { tenantId } = payment.notes || {};
    if (!tenantId) return;
    this.logger.warn(`Payment failed for tenant ${tenantId}: ${payment.id}`);
  }

  private async onSubscriptionActivated(sub: any) {
    this.logger.log(`Razorpay subscription activated: ${sub.id}`);
    await this.subRepo.update({ razorpaySubId: sub.id }, { status: SubscriptionStatus.ACTIVE });
  }

  private async onSubscriptionCharged(sub: any) {
    this.logger.log(`Razorpay subscription renewed: ${sub.id}`);
    const dbSub = await this.subRepo.findOne({ where: { razorpaySubId: sub.id } });
    if (!dbSub) return;
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    dbSub.currentPeriodStart = now;
    dbSub.currentPeriodEnd = end;
    dbSub.status = SubscriptionStatus.ACTIVE;
    await this.subRepo.save(dbSub);
  }

  private async onSubscriptionCancelled(sub: any) {
    this.logger.log(`Razorpay subscription cancelled: ${sub.id}`);
    await this.subRepo.update(
      { razorpaySubId: sub.id },
      { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
    );
  }

  private async onSubscriptionHalted(sub: any) {
    this.logger.warn(`Razorpay subscription halted (past due): ${sub.id}`);
    await this.subRepo.update({ razorpaySubId: sub.id }, { status: SubscriptionStatus.PAST_DUE });
  }
  async fetchPayments(count: number = 20, skip: number = 0): Promise<any> {
    const { client } = await this.getClientInfo();
    if (!client) {
      throw new BadRequestException('Razorpay is not configured');
    }
    
    try {
      const response = await client.payments.all({ count, skip });
      return response;
    } catch (e: any) {
      this.logger.error('Failed to fetch payments from Razorpay', e);
      throw new BadRequestException('Failed to fetch payments from Razorpay');
    }
  }
}
