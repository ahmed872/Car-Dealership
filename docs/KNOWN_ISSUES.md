# Known Issues, Risks & External Dependencies

Severity: P0 (blocker) · P1 (high) · P2 (medium) · P3 (low).

## External dependencies (blocked — need credentials/approval)

| ID | Item | Status | What is needed |
|---|---|---|---|
| EXT-01 | E-invoicing: ZATCA (KSA), FTA (UAE), ETA (Egypt) | Not implemented | Certified integration, onboarding credentials, legal review |
| EXT-02 | WhatsApp Business API / SMS / email delivery | Adapter interface + log-only adapter | Provider account & API keys |
| EXT-03 | Subscription billing payment gateway | Internal plan model only; gateway adapter disabled | Choice of provider (e.g. Stripe/PayTabs/Paymob) + keys |
| EXT-04 | OCR of documents | Interface only | Provider choice + keys |
| EXT-05 | AI text generation (ad copy, summaries) | Anthropic adapter, disabled without key; template fallback | `ANTHROPIC_API_KEY` |
| EXT-06 | Market price data / traffic fines / insurance APIs | Not implemented (no assumed official APIs) | Market-specific research & contracts |
| EXT-07 | Object storage (S3/R2) in production | S3 driver implemented, tested only with local driver | Bucket + credentials |
| EXT-08 | Production deployment | Not performed | Hosting account, domain, TLS |

## Open issues

| ID | Severity | Issue | Plan |
|---|---|---|---|
| KI-001 | P1 | Foreign keys from tenant tables to other tenant tables are single-column. An FK check bypasses RLS, so a service that does not first look up the referenced row through RLS could store another company's id. Services now look references up through RLS; the cash-account branch hole found in review is fixed. | Phase 8: composite `(tenant_id, id)` foreign keys on all tenant tables. |
| KI-002 | P2 | Unrealized FX (period-end revaluation of open foreign balances) is not implemented; only realized FX is posted (D-019). | Phase 6/8 reporting enhancement. |
| KI-003 | P2 | Supplier advances (payments not tied to a document) are not supported (D-016). | Future enhancement. |
| KI-004 | P3 | Allocation remainder cents go to the largest fractions (ties to the first row), not "the last vehicle". FINANCIAL_POLICIES wording corrected. | Done (documentation). |
| KI-005 | P3 | Work orders have no version column. An approver holding a stale screen could approve a work order that was rejected, edited and completed again since they opened it. Its current items are what get posted, and the approver is still not a maker. | Add a version to work orders, and check it on approve, as for acquisitions (Phase 8). |
| KI-006 | P2 | Writes of one company are serialised (D-025). This is fine at dealership volumes; a very large multi-branch group could see queueing at peak. | Monitor lock wait time (Phase 8 observability); split the lock by branch if ever needed. |

