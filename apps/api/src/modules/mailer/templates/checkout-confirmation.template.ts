import { baseLayout, formatCurrency, formatDate } from './base.template';

export function checkoutConfirmationTemplate(opts: {
  guestName: string;
  roomNumber: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  numNights: number;
  totalAmount: number;
  branchName: string;
}): string {
  const body = `
    <h2>Thank you for staying with us, ${opts.guestName}! 🏨</h2>
    <p>We hope you enjoyed your stay at <strong>${opts.branchName}</strong>. Here is a summary of your visit.</p>

    <div class="card">
      <div class="row"><span class="label">Room</span><span class="value">${opts.roomNumber} — ${opts.roomType}</span></div>
      <div class="row"><span class="label">Check-in</span><span class="value">${opts.checkInDate}</span></div>
      <div class="row"><span class="label">Check-out</span><span class="value">${opts.checkOutDate}</span></div>
      <div class="row"><span class="label">Nights</span><span class="value">${opts.numNights}</span></div>
      <div class="row total"><span class="label">Total</span><span class="value">${formatCurrency(opts.totalAmount)}</span></div>
    </div>

    <p>If you have any feedback or queries about your stay, feel free to reply to this email.</p>

    <p style="font-size:13px;color:#71717a">We look forward to welcoming you again soon!</p>
  `;
  return baseLayout(`Checkout Confirmation — ${opts.branchName}`, body);
}
