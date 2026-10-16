# AutoHub Pro — engineering conventions

Car-dealership management SaaS (Egypt / KSA / UAE). pnpm monorepo:
`packages/shared` (zod schemas, Decimal money, finance calculators, permissions, lifecycle),
`apps/api` (NestJS 11 + Drizzle + PostgreSQL 16 with RLS), `apps/web` (React 19 + Vite + Tailwind 4, AR RTL / EN LTR),
`e2e` (Playwright 1.56.1). Read `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` before changing financial logic.

## Non-negotiables
- **Money**: never use JS numbers for money. Amounts are strings (`"1500.00"`), DB `numeric(18,2)`. Use
  `d()`, `money()`, `sum()`, `convert()`, `allocateProportionally()` from `@autohub/shared`. Round with the
  tenant's rounding mode only at defined points.
- **Ledger**: every financial event posts a balanced entry via `PostingService.post()` in the SAME transaction
  as the business change. `(sourceType, sourceId, event)` is unique — reuse that to make postings idempotent.
  Never update/delete ledger, cash book or audit rows; corrections are reversals (`PostingService.reverse`).
- **Cash**: every cash movement goes through `CashService.move()` (cash book row + GL entry together).
- **Tenant isolation**: RLS enforces `tenant_id = app_current_tenant()`. Insert `tenantId: ctx.tenant.id`.
  Never accept tenant ids from the client. Also enforce branch scope with `assertBranchAccess(ctx, branchId)`
  and filter lists with `ctx.allBranches ? … : inArray(x.branchId, ctx.branchIds)`.
- **Permissions**: every controller route declares `@RequirePermissions(...)`, `@Authenticated()`, `@Public()` or
  `@PlatformAdmin()` (deny by default). Sensitive extra checks inside services use `assertPermission(ctx, p)`.
- **Concurrency**: lock rows that guard invariants with `.for('update')` (e.g. `VehiclesService.lock(id)`).
  Vehicle status changes ONLY via `VehiclesService.transition()`.
- **Idempotency**: money-creating POST routes add `@Idempotent()` (client sends `Idempotency-Key`).
- **Audit**: sensitive changes call `AuditService.record({action, entityType, entityId, before, after})`.
- **Errors**: throw `AppError` helpers (`notFound`, `conflict(code,msg)`, `unprocessable(code,msg)`, `forbidden`)
  with stable snake_case codes; register unique-constraint names with `registerUniqueConstraint`.
- No fake data, no placeholder buttons, no fabricated integrations or test results.

## API patterns (apps/api)
- Each request runs in ONE DB transaction (TenantTransactionInterceptor). Inside services use `this.dbs.db`
  (Drizzle) and `this.dbs.query(sql, params)`; never open a nested transaction with a different context.
  Upload/long routes use `@NoTransaction()` and call `dbs.runInTenant({tenantId, userId}, fn)` themselves.
- Controller signature: `@Ctx() ctx: TenantContext`, zod DTOs via `class XDto extends createZodDto(zX) {}`.
- Input schemas live in `packages/shared/src/schemas/*` (rebuild shared with `pnpm --filter @autohub/shared build`
  after editing — the API consumes `dist`).
- Document numbers: `NumberingService.next('acquisition' | 'expense' | …)` (gapless per tenant/year).
- Dates: business dates are ISO `YYYY-MM-DD` strings; "today" = `todayInZone(ctx.tenant.settings.timezone)`.
- Register new Nest modules in `apps/api/src/domain-modules.ts`; global services come from `CoreModule`
  and `FinanceModule` (CashService, CashAccountsService, PayablesService, SupplierPaymentsService, ApprovalsService).
- Correlated subqueries in `sql\`\`` MUST reference the outer column by its literal qualified name
  (`cash_accounts.id`), NOT `${table.col}` — Drizzle renders an unqualified `"id"` for single-table selects,
  which silently binds to the inner table.
- Money flows to reuse (never re-implement): `CashService.move/reverse/transfer` (cash book + GL together),
  `SupplierPaymentsService.pay/void` (allocations to payable docs: acquisition | vehicle_cost | expense),
  `PayablesService.describe` (payable/outstanding of a doc), `ApprovalsService.open/resolve` (approval inbox),
  `CostsService.create/approve/reverse` (vehicle costs), `resolveFx(ctx, currency, rate)` (base conversion).
- Schema changes: edit `apps/api/src/db/schema/*.ts`, then `npx drizzle-kit generate --name x` in apps/api;
  RLS/grants/triggers go in a `--custom` migration using `app_enable_tenant_rls('table')`.

## Tests
- API integration tests: `apps/api/test/*.spec.ts` with helpers in `test/helpers.ts` (`createTenant`,
  `addMember`, `Client`, `idem()`, `ownerPool()`) and domain fixtures in `test/fixtures.ts` (`createVehicle`,
  `makeAvailable`, `createSupplier`, `createCashAccount`, `costCategory`, `createAcquisition`), real PostgreSQL.
  Never import one spec file from another (it re-registers its tests); shared helpers go in fixtures.ts. Run from `apps/api`: `npx vitest run test/x.spec.ts`.
- Parallel agents MUST use their own database to avoid clobbering:
  `TEST_DATABASE_URL=postgres://autohub_app:autohub_app_dev@localhost:5432/autohub_test_<x>`
  `TEST_DATABASE_MIGRATION_URL=postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test_<x>`
  (databases `autohub_test_a` … `autohub_test_h` exist). If PostgreSQL is down: `service postgresql start`.
- Test failures and success paths, permission denials, cross-tenant access (expect 404), and ledger balances.

## Web patterns (apps/web)
- Data: `useApi(key, path, query)` / `useApiMutation({path, method, invalidate, idempotent})` from `@/lib/hooks`.
- UI kit: `@/components/ui/*` (Button, Field/Input/Select/MoneyInput, Card, StatCard, DataTable, Pagination,
  Modal, ConfirmDialog(requireReason), Tabs, PageHeader, Badge, Alert, EmptyState). Money display: `fmtMoney`.
- i18n: every visible string via `t()`; each feature owns `src/i18n/<feature>.ts` exporting `{ar, en}` with
  `en` typed as `typeof ar`. Use logical CSS (`ms-/me-/ps-/pe-/start-/end-`), never left/right.
- Gate UI with `<Can perm>` / `useAuth().can` (UX only — the server enforces).
