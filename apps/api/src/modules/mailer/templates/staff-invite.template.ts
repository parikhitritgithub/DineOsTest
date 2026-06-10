import { baseLayout } from './base.template';

export function staffInviteTemplate(opts: {
  employeeName: string;
  role: string;
  branchName: string;
  businessName: string;
  loginLink: string;
}): string {
  const roleLabel = opts.role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const body = `
    <h2>Welcome to the team, ${opts.employeeName}! 👋</h2>
    <p>You have been added as a staff member at <strong>${opts.businessName}</strong>.</p>

    <div class="card">
      <div class="row"><span class="label">Role</span><span class="value"><span class="badge badge-green">${roleLabel}</span></span></div>
      <div class="row"><span class="label">Branch</span><span class="value">${opts.branchName}</span></div>
      <div class="row"><span class="label">Business</span><span class="value">${opts.businessName}</span></div>
    </div>

    <p>Please contact your manager for your login credentials (email/phone and password or PIN).</p>

    <a class="btn" href="${opts.loginLink}">Open Dine&amp;Stay OS →</a>

    <p style="font-size:13px;color:#71717a">
      If you believe this was sent in error, you can safely ignore this email.
    </p>
  `;
  return baseLayout('You\'ve been added to Dine&Stay OS', body);
}
