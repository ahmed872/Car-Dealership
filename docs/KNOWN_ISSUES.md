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
(Populated as phases progress.)
