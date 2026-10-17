import { CreditCard, ReceiptText, ShoppingCart, Truck } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { AcquisitionDetailPage } from './AcquisitionDetailPage';
import { AcquisitionFormPage } from './AcquisitionFormPage';
import { AcquisitionsListPage } from './AcquisitionsListPage';
import { ApGate } from './components';
import { PayablesPage } from './PayablesPage';
import { SupplierDetailPage } from './SupplierDetailPage';
import { SupplierPaymentDetailPage } from './SupplierPaymentDetailPage';
import { SupplierPaymentFormPage } from './SupplierPaymentFormPage';
import { SupplierPaymentsListPage } from './SupplierPaymentsListPage';
import { SuppliersListPage } from './SuppliersListPage';

/**
 * Routes, nav items, vehicle tabs and header widgets contributed by the purchasing feature.
 * Accounts-payable pages need suppliers.read AND payments.read (or supplier_payments.create for the
 * open documents and the payment form); <Guard anyOf> admits the candidates and <ApGate> applies
 * the exact rule the API enforces.
 */
export const purchasingModule: FeatureModule = {
  routes: [
    { path: 'purchasing/acquisitions', element: <Guard anyOf={['acquisitions.read']}><AcquisitionsListPage /></Guard> },
    { path: 'purchasing/acquisitions/new', element: <Guard anyOf={['acquisitions.create']}><AcquisitionFormPage /></Guard> },
    { path: 'purchasing/acquisitions/:id', element: <Guard anyOf={['acquisitions.read']}><AcquisitionDetailPage /></Guard> },
    { path: 'purchasing/suppliers', element: <Guard anyOf={['suppliers.read']}><SuppliersListPage /></Guard> },
    { path: 'purchasing/suppliers/:id', element: <Guard anyOf={['suppliers.read']}><SupplierDetailPage /></Guard> },
    {
      path: 'purchasing/payables',
      element: (
        <Guard anyOf={['supplier_payments.create', 'suppliers.read', 'payments.read']}>
          <ApGate need="open">
            <PayablesPage />
          </ApGate>
        </Guard>
      ),
    },
    {
      path: 'purchasing/payments',
      element: (
        <Guard anyOf={['suppliers.read', 'payments.read']}>
          <ApGate need="read">
            <SupplierPaymentsListPage />
          </ApGate>
        </Guard>
      ),
    },
    { path: 'purchasing/payments/new', element: <Guard anyOf={['supplier_payments.create']}><SupplierPaymentFormPage /></Guard> },
    {
      path: 'purchasing/payments/:id',
      element: (
        <Guard anyOf={['suppliers.read', 'payments.read']}>
          <ApGate need="read">
            <SupplierPaymentDetailPage />
          </ApGate>
        </Guard>
      ),
    },
  ],
  nav: [
    { group: 'purchasing', item: { to: '/app/purchasing/acquisitions', labelKey: 'nav.acquisitions', icon: ShoppingCart, anyOf: ['acquisitions.read'] } },
    { group: 'purchasing', item: { to: '/app/purchasing/suppliers', labelKey: 'nav.suppliers', icon: Truck, anyOf: ['suppliers.read'] } },
    // NavItem.anyOf cannot express "suppliers.read AND payments.read". Keying on suppliers.read (plus
    // supplier_payments.create for the open documents) keeps sales-side payments.read roles out; the
    // pages re-check the exact rule with <ApGate>. The payments history needs read access, so a
    // pay-only role reaches the payment form from the payables page instead.
    { group: 'purchasing', item: { to: '/app/purchasing/payables', labelKey: 'purchasing.nav.payables', icon: ReceiptText, anyOf: ['supplier_payments.create', 'suppliers.read'] } },
    { group: 'purchasing', item: { to: '/app/purchasing/payments', labelKey: 'purchasing.nav.payments', icon: CreditCard, anyOf: ['suppliers.read'] } },
  ],
};
