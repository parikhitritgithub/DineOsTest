import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { welcomeTemplate } from './templates/welcome.template';
import { passwordResetTemplate } from './templates/password-reset.template';
import { shiftSummaryTemplate } from './templates/shift-summary.template';
import { billTemplate } from './templates/bill.template';
import { trialExpiryTemplate } from './templates/trial-expiry.template';
import { checkoutConfirmationTemplate } from './templates/checkout-confirmation.template';
import { staffInviteTemplate } from './templates/staff-invite.template';
import { subscriptionActivatedTemplate } from './templates/subscription-activated.template';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly resend: Resend;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>(
      'EMAIL_FROM',
      'onboarding@resend.dev',
    );

    const apiKey = this.config.get<string>('RESEND_API_KEY');

    if (!apiKey) {
      throw new Error('RESEND_API_KEY is missing');
    }

    this.resend = new Resend(apiKey);
  }

  async send(options: SendMailOptions): Promise<boolean> {
    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        attachments: options.attachments?.map(a => ({
          filename: a.filename,
          content: typeof a.content === 'string'
            ? a.content
            : a.content.toString('base64'),
        })),
      });

      if (error) {
        this.logger.error(error);
        return false;
      }

      this.logger.log(`Email sent to ${options.to}`);
      return true;
    } catch (err) {
      this.logger.error(err);
      return false;
    }
  }

  // ─── Templated helpers ────────────────────────────────────────────────────

  async sendWelcome(opts: { to: string; businessName: string; ownerName: string; trialEndsAt: Date }) {
    return this.send({
      to: opts.to,
      subject: `Welcome to Dine&Stay OS — your 14-day trial has started!`,
      html: welcomeTemplate(opts),
    });
  }

  async sendPasswordReset(opts: { to: string; name: string; resetLink: string; expiresIn: string }) {
    return this.send({
      to: opts.to,
      subject: `Reset your Dine&Stay OS password`,
      html: passwordResetTemplate(opts),
    });
  }

  async sendShiftSummary(opts: {
    to: string | string[];
    branchName: string;
    shiftNumber: string;
    openedBy: string;
    closedBy: string;
    openedAt: Date;
    closedAt: Date;
    totalSales: number;
    totalOrders: number;
    cashSales: number;
    cardSales: number;
    upiSales: number;
    openingCash: number;
    closingCash: number;
    expectedCash: number;
    cashDifference: number;
  }) {
    return this.send({
      to: opts.to,
      subject: `Shift Summary — ${opts.branchName} | ${opts.shiftNumber}`,
      html: shiftSummaryTemplate(opts),
    });
  }

  async sendBillEmail(opts: {
    to: string;
    customerName: string;
    billNumber: string;
    grandTotal: number;
    branchName: string;
    items: Array<{ name: string; qty: number; rate: number; total: number }>;
    payments: Array<{ method: string; amount: number }>;
    cgst: number;
    sgst: number;
    igst: number;
    issuedAt: Date;
    attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
  }) {
    return this.send({
      to: opts.to,
      subject: `Your bill from ${opts.branchName} — ${opts.billNumber}`,
      html: billTemplate(opts),
      attachments: opts.attachments,
    });
  }

  async sendTrialExpiry(opts: { to: string; businessName: string; trialEndsAt: Date; upgradeLink: string }) {
    return this.send({
      to: opts.to,
      subject: `Your Dine&Stay OS trial expires in 3 days`,
      html: trialExpiryTemplate(opts),
    });
  }

  async sendCheckoutConfirmation(opts: {
    to: string;
    guestName: string;
    roomNumber: string;
    roomType: string;
    checkInDate: string;
    checkOutDate: string;
    numNights: number;
    totalAmount: number;
    branchName: string;
  }) {
    return this.send({
      to: opts.to,
      subject: `Checkout Confirmation — ${opts.branchName}`,
      html: checkoutConfirmationTemplate(opts),
    });
  }

  async sendStaffInvite(opts: {
    to: string;
    employeeName: string;
    role: string;
    branchName: string;
    businessName: string;
  }) {
    const appUrl = this.config.get('APP_URL', 'http://localhost:3001');
    return this.send({
      to: opts.to,
      subject: `You've been added to ${opts.businessName} on Dine&Stay OS`,
      html: staffInviteTemplate({ ...opts, loginLink: `${appUrl}/login` }),
    });
  }

  async sendSubscriptionActivated(opts: {
    to: string;
    businessName: string;
    planName: string;
    priceMonthly: number;
    nextBillingDate: Date;
  }) {
    return this.send({
      to: opts.to,
      subject: `Subscription Activated — ${opts.planName} plan`,
      html: subscriptionActivatedTemplate(opts),
    });
  }
}