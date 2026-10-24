# Known Issues, Risks & External Dependencies

Severity: P0 (blocker) · P1 (high) · P2 (medium) · P3 (low).

## External dependencies (blocked — need credentials/approval)

| ID | Item | Status | What is needed |
|---|---|---|---|
| EXT-01 | E-invoicing: ZATCA (KSA), FTA (UAE), ETA (Egypt) | Not implemented | Certified integration, onboarding credentials, legal review |
| EXT-02 | WhatsApp Business API / SMS / email delivery | Log-only adapter (default) and a generic signed-webhook adapter for a company's own gateway; every message is recorded in `message_log`. No direct WhatsApp/SMS/email provider is integrated. | Provider account & API keys |
| EXT-03 | Subscription billing payment gateway | Internal plan model only; gateway adapter disabled | Choice of provider (e.g. Stripe/PayTabs/Paymob) + keys |
| EXT-04 | OCR of documents | Interface only (returns 501 `integration_not_available`) | Provider choice + keys |
| EXT-05 | AI text generation (listing descriptions) | Anthropic adapter, per-company key entered in Integrations (encrypted); off by default; deterministic template fallback. Tested only against a local stub, never against the live API. | A company's Anthropic API key |
| EXT-06 | Market price data / traffic fines / insurance APIs | Not implemented (no assumed official APIs) | Market-specific research & contracts |
| EXT-07 | Object storage (S3/R2) in production | S3 driver implemented, tested only with local driver | Bucket + credentials |
| EXT-08 | Production deployment | Not performed | Hosting account, domain, TLS |

## Open issues

| ID | Severity | Issue | Plan |
|---|---|---|---|
| KI-001 | — | ~~Single-column foreign keys between tenant tables could accept another company's id.~~ | **Resolved (Phase 8, D-039):** composite tenant keys and catalog triggers, enforced by the database. |
| KI-002 | P2 | Unrealized FX (period-end revaluation of open foreign balances) is not implemented; only realized FX is posted (D-019). | Phase 6/8 reporting enhancement. |
| KI-003 | P2 | Supplier advances (payments not tied to a document) are not supported (D-016). | Future enhancement. |
| KI-004 | P3 | Allocation remainder cents go to the largest fractions (ties to the first row), not "the last vehicle". FINANCIAL_POLICIES wording corrected. | Done (documentation). |
| KI-005 | — | ~~Work orders had no version, so a stale approval screen could approve a changed order.~~ | **Resolved (Phase 8, D-040):** trigger-maintained version checked on approve. |
| KI-006 | P2 | Writes of one company are serialised (D-025). This is fine at dealership volumes; a very large multi-branch group could see queueing at peak. | Monitor lock wait time (Phase 8 observability); split the lock by branch if ever needed. |
| KI-007 | P2 | Cancelling or returning a sale keeps a received trade-in vehicle in stock; its agreed value stays in the customer's refundable credit (the dealer has, in effect, bought it). Handing the trade-in car back is not automated. | Manual today: refund the credit, or remove the trade-in vehicle and adjust. A "return trade-in" flow is a future enhancement. |
| KI-008 | P2 | After cancellation or return, all money is refundable credit. There is no restocking or cancellation fee posting for sale credit, and credit left after a partial refund cannot yet be applied to another sale. | Future enhancement: a forfeit-to-4200 action with a reason (like reservations) and applying customer credit to a sale. |
| KI-009 | P3 | A sale has one vehicle and no extra lines (accessories, registration, warranty, dealer fees). | Future enhancement: priced sale lines with their own tax. |
| KI-010 | P2 | Contracts, invoices and credit notes are commercial documents, not certified tax e-invoices (no ZATCA/FTA/ETA clearance or QR). The PDFs say so. | Needs EXT-01. |
| KI-011 | P3 | Cash-closing differences can be posted only on base-currency accounts; foreign-currency accounts must be corrected with a transfer first. | By design for now (D-032). |
| KI-012 | P3 | A commission stays earned if a payment is voided after it was earned; it is only reversed or clawed back when the sale is cancelled or returned. Costs posted after confirmation do not change the commission. | Accepted (rule snapshot at confirmation); review with the business. |
| KI-013 | P3 | For externally financed sales, the provider's payment is recorded as a receipt on the customer's sale; there is no separate receivable from the finance provider. | Future enhancement: finance-provider sub-ledger. |
| KI-014 | P3 | Reports are not paginated; one run returns at most 20,000 rows and says when it was cut (`truncated`). | Narrow the filters; add paging or background export jobs if a customer needs more. |
| KI-015 | P3 | Receivables aging: installment sales age by their oldest unpaid installment; other sales age from the recognition date (the whole balance counts as overdue, since it was due at delivery). | Accepted; per-sale due dates for external-finance balances would refine it. |
| KI-016 | P3 | The dashboard shows customer advances only to all-branch users, because reservation deposits carry no branch. | By design. |
| KI-017 | P3 | VIN decoding uses the free NHTSA vPIC service, which covers vehicles built for the North American market well and GCC/Egypt-spec vehicles only partly. Results are suggestions; the user confirms make, model and year. Tested only against a local stub. | Add a regional decoder if a provider is chosen. |
| KI-018 | P2 | No CAPTCHA on public inquiries (needs a provider such as Cloudflare Turnstile and keys). Abuse is bounded by the per-client rate limit, the honeypot, repeat attachment and the per-company daily cap. | Add a CAPTCHA adapter when a provider is chosen. |
| KI-019 | P3 | The showroom inquiry rate limit is per client address and process-local (in-memory throttler). Several API instances behind a load balancer each keep their own count, and behind a reverse proxy `TRUST_PROXY` must be on or all visitors share one address. | Shared (Redis) throttler storage for multi-instance deployments; set `TRUST_PROXY` behind a proxy. |
| KI-020 | P3 | Price guidance needs at least three of the company's own recognised sales of the same make/model (±2 years); new companies will mostly see "not enough data". No external market prices are used (EXT-06). | By design. |
| KI-021 | P2 | Showroom inquiries and the message log are append-only and hold personal data of people who are not customers; there is no erasure or retention job yet (KSA PDPL, UAE PDPL, Egypt Law 151/2020 give data subjects erasure rights). | Phase 8 or later: a SECURITY DEFINER redaction function and a retention policy, reviewed with counsel. |
| KI-022 | P3 | A message delivered by the webhook is recorded in its own transaction after the business commit; if the process stops between the two, the message may be sent but not recorded. | Accepted; an outbox table would make it exact. |
| KI-023 | P2 | Performance is verified only by an in-process smoke test (one company, 1,500 customers, 250 vehicles, 120 sales; every read route p95 ≤ 35 ms, xlsx export 111 ms — TEST_REPORT). No load test with concurrent users, network, or production data volumes has been run. | Load test (e.g. k6) against a staging deployment before go-live; size PostgreSQL and the Chromium PDF pool from it. |
| KI-024 | P2 | `APP_ENCRYPTION_KEY` cannot be rotated: ciphertexts carry no key id (`common/crypto.ts`) and the national-ID lookup hashes (customers and suppliers) are derived from the same key, so changing the key breaks decryption and exact lookups. OPERATIONS.md §6 says so. | Key ids in ciphertexts, a previous-key setting and a re-encrypt/re-hash command. |
| KI-025 | P3 | `/health/ready` checks the database and a known function, not that the newest migration is applied; an API started before `migrate` finishes can report ready. The Compose stack avoids this by starting the API only after the migrate service succeeds. | Compare the latest applied migration with the build's. |
| KI-026 | P3 | A company admin can tell whether an email already has an account: adding it returns `status: 'invited'` for an existing account and `'active'` for a new one (and only new accounts pay for a password hash). | Invite new accounts by email too (needs a mail provider, EXT-02), then answer identically. |
| KI-027 | P3 | Invitations never expire and the inviting company cannot withdraw one; it waits until the invitee accepts or declines. | Add a withdraw route and an expiry job. |
| KI-028 | P3 | The `users` table (global, one row per person) has no RLS; isolation relies on application filtering through memberships. | Accepted; covered by the isolation sweep and security-review specs. |
| KI-029 | P3 | Report PDFs render inside the request's read transaction, so a queued render holds a DB connection (queue capped at 4); the export rate limit is per client address and per process. A refused PDF export (422/429/503) opens as raw JSON because exports are plain download links. | Render after reading the data outside the transaction; shared throttler storage; fetch-based downloads with error toasts. |
| KI-030 | P2 | Supplier national IDs written before D-047 stay in plain text in `suppliers.national_id` until `cli.js encrypt-supplier-ids` has run (OPERATIONS §1, step 7), and backups taken earlier keep them. The application no longer writes the column, but it still exists (dropping it in the same release would break the previous release during the rollout). | Next release: a migration that refuses to run while any `suppliers.national_id` is not NULL, then drops the column; operators run the command before upgrading. |
| KI-031 | P3 | Approval inbox summaries are plain text written by the API when the request is opened (English, unformatted amounts such as `SO-…: 96000.00 (−3.0303%)`); the amount column is formatted and translated. | Store structured payloads only and render summaries in the web per language. |
| KI-032 | P3 | `DataTable` has a 640px minimum width, so tables inside narrow cards scroll horizontally within the card (cash closing was reworked; others remain). The Reports salesperson filter still lists users through `GET /users` (needs former staff, so it stays behind users.read). | Responsive card layouts for narrow tables. |
| KI-033 | P3 | The shared `MoneyInput` puts the currency tag over the digits in Arabic; features use local wrappers (`rtl:ps-14`) as a workaround. | Fix in `components/ui/Field.tsx` and remove the wrappers. |

