import { baseLayout, formatCurrency, formatDate } from './base.template';

export function subscriptionActivatedTemplate(opts: {
  businessName: string;
  planName: string;
  priceMonthly: number;
  nextBillingDate: Date;
}): string {
  const body = `
    <h2>Subscription Activated 🎉</h2>
    <p>Great news! Your <strong>${opts.businessName}</strong> account has been upgraded successfully.</p>

    <div class="card">
      <div class="row"><span class="label">Plan</span><span class="value"><span class="badge badge-green">${opts.planName}</span></span></div>
      <div class="row"><span class="label">Monthly price</span><span class="value">${formatCurrency(opts.priceMonthly)}</span></div>
      <div class="row"><span class="label">Next billing date</span><span class="value">${formatDate(opts.nextBillingDate)}</span></div>
    </div>

    <p>You now have full access to all features included in your plan. Thank you for choosing Dine&amp;Stay OS!</p>

    <a class="btn" href="https://app.dinestay.app/settings/billing">Manage Subscription →</a>

    <p style="font-size:13px;color:#71717a">
      Need help? Reply to this email or visit our <a href="https://docs.dinestay.app" style="color:#f97316">documentation</a>.
    </p>
  `;
  return baseLayout('Subscription Activated — Dine&Stay OS', body);
}
