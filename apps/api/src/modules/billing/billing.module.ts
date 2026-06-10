import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PdfService } from './pdf.service';
import { Bill } from './entities/bill.entity';
import { Payment } from './entities/payment.entity';
import { GstRate } from './entities/gst-rate.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Shift } from '../shifts/entities/shift.entity';
import { Branch } from '../branches/entities/branch.entity';
import { SubscriptionGuard } from '../auth/guards/subscription.guard';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Plan } from '../subscriptions/entities/plan.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Bill, Payment, GstRate, Order, OrderItem, Shift, Branch, Subscription, Plan])],
  providers: [BillingService, PdfService, SubscriptionGuard],
  controllers: [BillingController],
  exports: [BillingService],
})
export class BillingModule { }
