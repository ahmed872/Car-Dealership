# Permission matrix

Generated from the route metadata by `apps/api/test/route-policies.spec.ts` (`WRITE_PERMISSION_MATRIX=1`).
Policies: `public` (no session), `platform_admin`, `permissions` (ALL listed permissions in the active company),
`authenticated` (any member of the active company), `signed_in` (signed in, no company needed). Branch scope and
ownership rules are enforced inside the services on top of this.

| Method | Path | Policy | Permissions | Idempotency key |
|---|---|---|---|---|
| GET | `/api/v1/acquisitions` | permissions | acquisitions.read |  |
| POST | `/api/v1/acquisitions` | permissions | acquisitions.create | required |
| GET | `/api/v1/acquisitions/:id` | permissions | acquisitions.read |  |
| PATCH | `/api/v1/acquisitions/:id` | permissions | acquisitions.create |  |
| POST | `/api/v1/acquisitions/:id/approve` | permissions | acquisitions.approve | required |
| POST | `/api/v1/acquisitions/:id/cancel` | permissions | acquisitions.cancel | required |
| PUT | `/api/v1/acquisitions/:id/ownership` | permissions | acquisitions.create |  |
| POST | `/api/v1/acquisitions/:id/reject` | permissions | acquisitions.approve |  |
| POST | `/api/v1/acquisitions/:id/submit` | permissions | acquisitions.create |  |
| GET | `/api/v1/appointments` | permissions | appointments.read |  |
| POST | `/api/v1/appointments` | permissions | appointments.manage |  |
| GET | `/api/v1/appointments/:id` | permissions | appointments.read |  |
| PATCH | `/api/v1/appointments/:id` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/cancel` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/complete` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/confirm` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/finish-test-drive` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/no-show` | permissions | appointments.manage |  |
| POST | `/api/v1/appointments/:id/start-test-drive` | permissions | appointments.manage |  |
| GET | `/api/v1/approvals` | authenticated |  |  |
| GET | `/api/v1/approvals/summary` | authenticated |  |  |
| GET | `/api/v1/audit-logs` | permissions | audit.read |  |
| POST | `/api/v1/audit-logs/verify` | permissions | audit.read |  |
| POST | `/api/v1/auth/change-password` | signed_in |  |  |
| POST | `/api/v1/auth/login` | public |  |  |
| POST | `/api/v1/auth/logout` | signed_in |  |  |
| GET | `/api/v1/auth/me` | signed_in |  |  |
| POST | `/api/v1/auth/switch-tenant` | signed_in |  |  |
| GET | `/api/v1/branches` | authenticated |  |  |
| POST | `/api/v1/branches` | permissions | branches.manage |  |
| PUT | `/api/v1/branches/:id` | permissions | branches.manage |  |
| GET | `/api/v1/cash-accounts` | permissions | cash.read |  |
| POST | `/api/v1/cash-accounts` | permissions | cash.manage_accounts | required |
| GET | `/api/v1/cash-accounts/:id` | permissions | cash.read |  |
| PATCH | `/api/v1/cash-accounts/:id` | permissions | cash.manage_accounts |  |
| GET | `/api/v1/cash-accounts/:id/closings` | permissions | cash.read |  |
| POST | `/api/v1/cash-accounts/:id/closings` | permissions | cash.close | required |
| GET | `/api/v1/cash-accounts/:id/closings/expected` | permissions | cash.read |  |
| GET | `/api/v1/cash-accounts/options` | authenticated |  |  |
| POST | `/api/v1/cash-closings/:id/reopen` | permissions | cash.reopen |  |
| GET | `/api/v1/cash/accounts/:id/book` | permissions | cash.read |  |
| GET | `/api/v1/cash/transfers` | permissions | cash.read |  |
| POST | `/api/v1/cash/transfers` | permissions | cash.transfer | required |
| GET | `/api/v1/cash/transfers/:transferId` | permissions | cash.read |  |
| POST | `/api/v1/cash/transfers/:transferId/reverse` | permissions | cash.transfer, payments.void | required |
| GET | `/api/v1/catalog/features` | authenticated |  |  |
| POST | `/api/v1/catalog/features` | permissions | vehicles.update |  |
| GET | `/api/v1/catalog/makes` | authenticated |  |  |
| POST | `/api/v1/catalog/makes` | permissions | vehicles.create |  |
| GET | `/api/v1/catalog/models` | authenticated |  |  |
| POST | `/api/v1/catalog/models` | permissions | vehicles.create |  |
| GET | `/api/v1/commission-policies` | authenticated |  |  |
| POST | `/api/v1/commission-policies` | permissions | commissions.manage_policies |  |
| POST | `/api/v1/commission-policies/:id/deactivate` | permissions | commissions.manage_policies |  |
| POST | `/api/v1/commission-policies/:id/versions` | permissions | commissions.manage_policies |  |
| POST | `/api/v1/commission-policies/preview` | authenticated |  |  |
| GET | `/api/v1/commission-policies/resolve` | authenticated |  |  |
| GET | `/api/v1/commissions` | authenticated |  |  |
| GET | `/api/v1/commissions/:id` | authenticated |  |  |
| POST | `/api/v1/commissions/:id/approve` | permissions | commissions.approve |  |
| POST | `/api/v1/commissions/:id/pay` | permissions | commissions.pay | required |
| GET | `/api/v1/company` | authenticated |  |  |
| PATCH | `/api/v1/company` | permissions | settings.manage |  |
| GET | `/api/v1/cost-categories` | authenticated |  |  |
| GET | `/api/v1/customers` | permissions | customers.read |  |
| POST | `/api/v1/customers` | permissions | customers.manage |  |
| GET | `/api/v1/customers/:id` | permissions | customers.read |  |
| PATCH | `/api/v1/customers/:id` | permissions | customers.manage |  |
| POST | `/api/v1/customers/:id/assign` | permissions | customers.read |  |
| POST | `/api/v1/customers/:id/deactivate` | permissions | customers.manage |  |
| GET | `/api/v1/customers/:id/interactions` | permissions | customers.read |  |
| POST | `/api/v1/customers/:id/reactivate` | permissions | customers.manage |  |
| GET | `/api/v1/customers/:id/sensitive` | permissions | customers.view_sensitive |  |
| POST | `/api/v1/customers/check-duplicates` | permissions | customers.read |  |
| GET | `/api/v1/dashboard` | permissions | dashboard.view |  |
| GET | `/api/v1/employees` | permissions | users.read |  |
| GET | `/api/v1/employees/:userId` | authenticated |  |  |
| PUT | `/api/v1/employees/:userId/profile` | permissions | users.manage |  |
| GET | `/api/v1/expense-categories` | authenticated |  |  |
| GET | `/api/v1/expenses` | permissions | expenses.read |  |
| POST | `/api/v1/expenses` | permissions | expenses.create | required |
| GET | `/api/v1/expenses/:id` | permissions | expenses.read |  |
| POST | `/api/v1/expenses/:id/approve` | permissions | expenses.approve |  |
| POST | `/api/v1/expenses/:id/reject` | permissions | expenses.approve |  |
| POST | `/api/v1/expenses/:id/reverse` | permissions | expenses.approve | required |
| GET | `/api/v1/expenses/summary` | permissions | expenses.read |  |
| GET | `/api/v1/files/:id` | authenticated |  |  |
| GET | `/api/v1/health/live` | public |  |  |
| GET | `/api/v1/health/ready` | public |  |  |
| GET | `/api/v1/inspections/:id` | permissions | inspections.read |  |
| PUT | `/api/v1/inspections/:id` | permissions | inspections.perform |  |
| POST | `/api/v1/inspections/:id/cancel` | permissions | inspections.perform |  |
| POST | `/api/v1/inspections/:id/complete` | permissions | inspections.perform |  |
| POST | `/api/v1/inspections/:id/media` | permissions | inspections.perform |  |
| GET | `/api/v1/inspections/templates` | permissions | inspections.read |  |
| POST | `/api/v1/inspections/templates` | permissions | inspections.manage_templates |  |
| PUT | `/api/v1/inspections/templates/:id` | permissions | inspections.manage_templates |  |
| GET | `/api/v1/installment-plans` | permissions | installments.read |  |
| GET | `/api/v1/installment-plans/:id` | permissions | installments.read |  |
| POST | `/api/v1/installment-plans/:id/settle` | permissions | installments.settle, payments.receive | required |
| GET | `/api/v1/installment-plans/:id/settlement-quote` | permissions | installments.read |  |
| GET | `/api/v1/integrations` | permissions | integrations.manage |  |
| PUT | `/api/v1/integrations/:provider` | permissions | integrations.manage |  |
| GET | `/api/v1/integrations/vin-decode/:vin` | permissions | vehicles.create |  |
| POST | `/api/v1/interactions` | permissions | customers.read |  |
| GET | `/api/v1/inventory/aging-recommendations` | permissions | vehicles.read, pricing.update |  |
| GET | `/api/v1/inventory/stock-counts` | permissions | inventory.count |  |
| POST | `/api/v1/inventory/stock-counts` | permissions | inventory.count |  |
| GET | `/api/v1/inventory/stock-counts/:id` | permissions | inventory.count |  |
| POST | `/api/v1/inventory/stock-counts/:id/reconcile` | permissions | inventory.reconcile |  |
| POST | `/api/v1/inventory/stock-counts/:id/scan` | permissions | inventory.count |  |
| POST | `/api/v1/inventory/stock-counts/:id/submit` | permissions | inventory.count |  |
| GET | `/api/v1/inventory/transfers` | permissions | vehicles.read |  |
| POST | `/api/v1/inventory/transfers/:id/cancel` | permissions | inventory.transfer |  |
| POST | `/api/v1/inventory/transfers/:id/receive` | permissions | inventory.transfer |  |
| GET | `/api/v1/leads` | permissions | leads.read |  |
| POST | `/api/v1/leads` | permissions | leads.manage |  |
| GET | `/api/v1/leads/:id` | permissions | leads.read |  |
| PATCH | `/api/v1/leads/:id` | permissions | leads.manage |  |
| POST | `/api/v1/leads/:id/assign` | permissions | leads.assign |  |
| POST | `/api/v1/leads/:id/lost` | permissions | leads.manage |  |
| POST | `/api/v1/leads/:id/reopen` | permissions | leads.manage |  |
| POST | `/api/v1/leads/:id/stage` | permissions | leads.manage |  |
| GET | `/api/v1/leads/board` | permissions | leads.read |  |
| GET | `/api/v1/leads/follow-ups` | permissions | leads.read |  |
| GET | `/api/v1/ledger/accounts` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/accounts/:code/statement` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/balance-sheet` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/entries` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/entries/:id` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/income-statement` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/reconciliation` | permissions | ledger.read |  |
| GET | `/api/v1/ledger/trial-balance` | permissions | ledger.read |  |
| GET | `/api/v1/me/invitations` | signed_in |  |  |
| POST | `/api/v1/me/invitations/:id/accept` | signed_in |  |  |
| POST | `/api/v1/me/invitations/:id/decline` | signed_in |  |  |
| GET | `/api/v1/members/assignable` | authenticated |  |  |
| GET | `/api/v1/notifications` | authenticated |  |  |
| POST | `/api/v1/notifications/:id/read` | authenticated |  |  |
| POST | `/api/v1/notifications/read-all` | authenticated |  |  |
| GET | `/api/v1/notifications/unread-count` | authenticated |  |  |
| GET | `/api/v1/payables/open` | authenticated |  |  |
| GET | `/api/v1/payables/summary` | permissions | suppliers.read, payments.read |  |
| GET | `/api/v1/permissions` | authenticated |  |  |
| GET | `/api/v1/pipeline-stages` | authenticated |  |  |
| POST | `/api/v1/pipeline-stages` | permissions | settings.manage |  |
| PATCH | `/api/v1/pipeline-stages/:id` | permissions | settings.manage |  |
| POST | `/api/v1/pipeline-stages/:id/activate` | permissions | settings.manage |  |
| POST | `/api/v1/pipeline-stages/:id/deactivate` | permissions | settings.manage |  |
| POST | `/api/v1/platform/signup` | public |  |  |
| GET | `/api/v1/platform/tenants` | platform_admin |  |  |
| POST | `/api/v1/platform/tenants` | platform_admin |  |  |
| POST | `/api/v1/privacy/redactions` | permissions | privacy.manage |  |
| POST | `/api/v1/privacy/search` | permissions | privacy.manage |  |
| GET | `/api/v1/public/showroom/:slug` | public |  |  |
| POST | `/api/v1/public/showroom/:slug/inquiries` | public |  |  |
| GET | `/api/v1/public/showroom/:slug/media/:mediaId` | public |  |  |
| GET | `/api/v1/public/showroom/:slug/vehicles` | public |  |  |
| GET | `/api/v1/public/showroom/:slug/vehicles/:listingId` | public |  |  |
| GET | `/api/v1/receipts` | permissions | payments.read |  |
| POST | `/api/v1/receipts` | permissions | payments.receive | required |
| GET | `/api/v1/receipts/:id` | permissions | payments.read |  |
| POST | `/api/v1/receipts/:id/void` | permissions | payments.void | required |
| GET | `/api/v1/refunds` | permissions | payments.read |  |
| POST | `/api/v1/refunds` | permissions | refunds.create | required |
| GET | `/api/v1/refunds/:id` | permissions | payments.read |  |
| POST | `/api/v1/refunds/:id/approve` | permissions | refunds.approve |  |
| POST | `/api/v1/refunds/:id/cancel` | permissions | payments.read |  |
| POST | `/api/v1/refunds/:id/pay` | permissions | payments.receive | required |
| POST | `/api/v1/refunds/:id/reject` | permissions | refunds.approve |  |
| GET | `/api/v1/reports/:key/export` | permissions | reports.export |  |
| GET | `/api/v1/reports/cash-flow` | permissions | reports.financial, cash.read |  |
| GET | `/api/v1/reports/inventory` | permissions | reports.view, vehicles.read |  |
| GET | `/api/v1/reports/leads` | permissions | reports.view |  |
| GET | `/api/v1/reports/receivables` | permissions | reports.financial |  |
| GET | `/api/v1/reports/sales` | permissions | reports.view |  |
| GET | `/api/v1/reservations` | permissions | reservations.read |  |
| POST | `/api/v1/reservations` | permissions | reservations.create | required |
| GET | `/api/v1/reservations/:id` | permissions | reservations.read |  |
| POST | `/api/v1/reservations/:id/cancel` | permissions | reservations.cancel | required |
| POST | `/api/v1/reservations/:id/deposits` | permissions | reservations.read, payments.receive | required |
| POST | `/api/v1/reservations/:id/extend` | permissions | reservations.extend |  |
| GET | `/api/v1/roles` | permissions | users.read |  |
| POST | `/api/v1/roles` | permissions | roles.manage |  |
| DELETE | `/api/v1/roles/:id` | permissions | roles.manage |  |
| PUT | `/api/v1/roles/:id` | permissions | roles.manage |  |
| GET | `/api/v1/sale-documents/:id/pdf` | permissions | sales.read |  |
| POST | `/api/v1/sale-documents/:id/void` | permissions | documents.void |  |
| GET | `/api/v1/sales` | permissions | sales.read |  |
| POST | `/api/v1/sales` | permissions | sales.create |  |
| GET | `/api/v1/sales/:id` | permissions | sales.read |  |
| PATCH | `/api/v1/sales/:id` | permissions | sales.create |  |
| POST | `/api/v1/sales/:id/approve` | authenticated |  |  |
| POST | `/api/v1/sales/:id/cancel` | authenticated |  | required |
| POST | `/api/v1/sales/:id/confirm` | permissions | sales.confirm | required |
| POST | `/api/v1/sales/:id/deliver` | permissions | sales.deliver | required |
| POST | `/api/v1/sales/:id/documents` | permissions | documents.issue |  |
| POST | `/api/v1/sales/:id/external-finance` | permissions | sales.confirm |  |
| POST | `/api/v1/sales/:id/reject` | authenticated |  |  |
| POST | `/api/v1/sales/:id/return` | permissions | sales.return | required |
| POST | `/api/v1/sales/:id/trade-ins` | permissions | sales.create |  |
| POST | `/api/v1/sales/:id/trade-ins/:tradeInId/remove` | permissions | sales.create |  |
| POST | `/api/v1/sales/preview` | permissions | sales.create |  |
| GET | `/api/v1/showroom/inquiries` | permissions | leads.assign |  |
| GET | `/api/v1/showroom/listings` | permissions | showroom.manage |  |
| GET | `/api/v1/supplier-payments` | permissions | suppliers.read, payments.read |  |
| POST | `/api/v1/supplier-payments` | permissions | supplier_payments.create | required |
| GET | `/api/v1/supplier-payments/:id` | permissions | suppliers.read, payments.read |  |
| POST | `/api/v1/supplier-payments/:id/void` | permissions | payments.void | required |
| GET | `/api/v1/suppliers` | permissions | suppliers.read |  |
| POST | `/api/v1/suppliers` | permissions | suppliers.manage |  |
| GET | `/api/v1/suppliers/:id` | permissions | suppliers.read |  |
| PATCH | `/api/v1/suppliers/:id` | permissions | suppliers.manage |  |
| GET | `/api/v1/suppliers/:id/sensitive` | permissions | suppliers.read, suppliers.view_sensitive |  |
| GET | `/api/v1/suppliers/:id/statement` | permissions | suppliers.read, payments.read |  |
| POST | `/api/v1/suppliers/check-duplicates` | permissions | suppliers.read |  |
| GET | `/api/v1/users` | permissions | users.read |  |
| POST | `/api/v1/users` | permissions | users.manage |  |
| PATCH | `/api/v1/users/:membershipId` | permissions | users.manage |  |
| POST | `/api/v1/users/:membershipId/reset-password` | permissions | users.manage |  |
| POST | `/api/v1/vehicle-costs` | permissions | costs.create | required |
| GET | `/api/v1/vehicle-costs/:id` | permissions | costs.read |  |
| POST | `/api/v1/vehicle-costs/:id/approve` | permissions | costs.approve |  |
| POST | `/api/v1/vehicle-costs/:id/reject` | permissions | costs.approve |  |
| POST | `/api/v1/vehicle-costs/:id/reverse` | permissions | costs.reverse | required |
| POST | `/api/v1/vehicle-costs/allocate` | permissions | costs.create | required |
| GET | `/api/v1/vehicle-costs/pending` | permissions | costs.approve |  |
| GET | `/api/v1/vehicles` | permissions | vehicles.read |  |
| POST | `/api/v1/vehicles` | permissions | vehicles.create |  |
| GET | `/api/v1/vehicles/:id` | permissions | vehicles.read |  |
| PATCH | `/api/v1/vehicles/:id` | permissions | vehicles.update |  |
| GET | `/api/v1/vehicles/:id/costs` | permissions | costs.read |  |
| POST | `/api/v1/vehicles/:id/documents` | permissions | vehicles.manage_documents |  |
| PATCH | `/api/v1/vehicles/:id/documents/:docId` | permissions | vehicles.manage_documents |  |
| POST | `/api/v1/vehicles/:id/documents/:docId/delete` | permissions | vehicles.manage_documents |  |
| PUT | `/api/v1/vehicles/:id/features` | permissions | vehicles.update |  |
| POST | `/api/v1/vehicles/:id/inspections` | permissions | inspections.perform |  |
| GET | `/api/v1/vehicles/:id/listing` | permissions | vehicles.read |  |
| PUT | `/api/v1/vehicles/:id/listing` | permissions | showroom.manage |  |
| POST | `/api/v1/vehicles/:id/listing/generate-description` | permissions | showroom.manage |  |
| POST | `/api/v1/vehicles/:id/listing/publish` | permissions | showroom.manage |  |
| GET | `/api/v1/vehicles/:id/listing/qr` | permissions | vehicles.read |  |
| POST | `/api/v1/vehicles/:id/listing/unpublish` | permissions | showroom.manage |  |
| POST | `/api/v1/vehicles/:id/media` | permissions | vehicles.manage_media |  |
| DELETE | `/api/v1/vehicles/:id/media/:mediaId` | permissions | vehicles.manage_media |  |
| PATCH | `/api/v1/vehicles/:id/media/:mediaId` | permissions | vehicles.manage_media |  |
| PUT | `/api/v1/vehicles/:id/media/order` | permissions | vehicles.manage_media |  |
| POST | `/api/v1/vehicles/:id/odometer` | permissions | vehicles.update |  |
| GET | `/api/v1/vehicles/:id/price-guidance` | permissions | vehicles.read, pricing.update |  |
| PUT | `/api/v1/vehicles/:id/pricing` | permissions | pricing.update |  |
| POST | `/api/v1/vehicles/:id/status` | permissions | vehicles.change_status |  |
| POST | `/api/v1/vehicles/:id/transfers` | permissions | inventory.transfer |  |
| GET | `/api/v1/vehicles/:id/work-orders` | permissions | work_orders.read |  |
| GET | `/api/v1/wishes` | permissions | customers.read |  |
| POST | `/api/v1/wishes` | permissions | customers.manage |  |
| GET | `/api/v1/wishes/:id` | permissions | customers.read |  |
| PATCH | `/api/v1/wishes/:id` | permissions | customers.manage |  |
| POST | `/api/v1/wishes/:id/cancel` | permissions | customers.manage |  |
| GET | `/api/v1/wishes/:id/explain/:vehicleId` | permissions | customers.read |  |
| POST | `/api/v1/wishes/:id/fulfil` | permissions | customers.manage |  |
| POST | `/api/v1/wishes/:id/matches/:vehicleId/dismiss` | permissions | customers.manage |  |
| GET | `/api/v1/wishes/for-vehicle/:vehicleId` | permissions | customers.read |  |
| GET | `/api/v1/work-orders` | permissions | work_orders.read |  |
| POST | `/api/v1/work-orders` | permissions | work_orders.manage |  |
| GET | `/api/v1/work-orders/:id` | permissions | work_orders.read |  |
| PATCH | `/api/v1/work-orders/:id` | permissions | work_orders.manage |  |
| POST | `/api/v1/work-orders/:id/approve` | permissions | work_orders.approve | required |
| POST | `/api/v1/work-orders/:id/cancel` | permissions | work_orders.manage |  |
| POST | `/api/v1/work-orders/:id/complete` | permissions | work_orders.manage |  |
| POST | `/api/v1/work-orders/:id/items` | permissions | work_orders.manage |  |
| DELETE | `/api/v1/work-orders/:id/items/:itemId` | permissions | work_orders.manage |  |
| PATCH | `/api/v1/work-orders/:id/items/:itemId` | permissions | work_orders.manage |  |
| POST | `/api/v1/work-orders/:id/reject` | permissions | work_orders.approve |  |
| POST | `/api/v1/work-orders/:id/start` | permissions | work_orders.manage |  |
