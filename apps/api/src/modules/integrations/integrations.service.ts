import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { INTEGRATION_PROVIDER_KEYS, IntegrationProvider, IntegrationUpdateInput, MESSAGING_PROVIDERS } from '@autohub/shared';
import { assertPermission, TenantContext } from '../../common/context';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { assertPublicHost, checkOutboundUrl, OutboundUrlError } from '../../common/outbound-http';
import { unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { integrationSettings } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { SubscriptionService } from '../tenancy/subscription.service';

export interface ResolvedIntegration {
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  secret: string | null;
}

/** What each provider is and whether this build has a working adapter for it. */
const CATALOG: Record<IntegrationProvider, { available: boolean; needsSecret: boolean; note: string }> = {
  vin_decoder: { available: true, needsSecret: false, note: 'NHTSA vPIC public VIN decoder (US data; coverage of GCC/Egypt-spec vehicles varies).' },
  ai_text: { available: true, needsSecret: true, note: 'Anthropic Claude for listing descriptions; a template is used when off or failing.' },
  messaging: { available: true, needsSecret: false, note: 'log: records messages without delivering them. webhook: posts each message to your own gateway URL (signed).' },
  ocr: { available: false, needsSecret: true, note: 'Interface only; no OCR provider is connected in this build.' },
};

/** A short secret would be half revealed by its last four characters. */
const showLast4 = (secret: string) => (secret.length >= 16 ? secret.slice(-4) : null);

/** The config as written to the audit log: URL query strings (often tokens) are left out. */
function auditConfig(config: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...config };
  if (typeof out.url === 'string') {
    try {
      const u = new URL(out.url);
      out.url = `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      /* invalid URLs are rejected before they are stored */
    }
  }
  return out;
}

/**
 * Per-company integration settings (D-035). Secrets are encrypted with the application key before
 * they are stored and are never returned; only the last four characters are shown.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly dbs: DbService,
    private readonly subscription: SubscriptionService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext) {
    assertPermission(ctx, 'integrations.manage');
    const rows = await this.dbs.db.select().from(integrationSettings);
    return INTEGRATION_PROVIDER_KEYS.map((p) => {
      const r = rows.find((x) => x.provider === p);
      return {
        provider: p,
        ...CATALOG[p],
        enabled: r?.enabled ?? false,
        config: (r?.config as Record<string, unknown>) ?? {},
        hasSecret: !!r?.secretEncrypted,
        secretLast4: r?.secretLast4 ?? null,
        updatedAt: r?.updatedAt ?? null,
      };
    });
  }

  async update(ctx: TenantContext, provider: IntegrationProvider, input: IntegrationUpdateInput) {
    assertPermission(ctx, 'integrations.manage');
    if (!CATALOG[provider].available && input.enabled) throw unprocessable('integration_not_available', `${provider} has no adapter in this build`);
    if (input.enabled) await this.subscription.assertFeature('integrations');
    const config = input.config ?? {};
    if (provider === 'messaging' && input.enabled) {
      const kind = String(config.provider ?? 'log');
      if (!(MESSAGING_PROVIDERS as readonly string[]).includes(kind)) throw unprocessable('invalid_config', 'Unknown messaging provider', { field: 'config.provider' });
      if (kind === 'webhook') await this.assertSafeUrl(String(config.url ?? ''));
    }
    const [existing] = await this.dbs.db.select().from(integrationSettings).where(eq(integrationSettings.provider, provider)).for('update');
    const secretFields =
      input.secret === undefined
        ? {}
        : input.secret === null
          ? { secretEncrypted: null, secretLast4: null }
          : { secretEncrypted: encryptSecret(input.secret), secretLast4: showLast4(input.secret) };
    if (existing) {
      await this.dbs.db
        .update(integrationSettings)
        .set({ enabled: input.enabled, config, ...secretFields, updatedBy: ctx.userId, updatedAt: new Date() })
        .where(and(eq(integrationSettings.id, existing.id)));
    } else {
      await this.dbs.db.insert(integrationSettings).values({ tenantId: ctx.tenant.id, provider, enabled: input.enabled, config, ...secretFields, updatedBy: ctx.userId });
    }
    await this.audit.record({
      action: 'integration.updated',
      entityType: 'integration',
      entityId: provider,
      before: existing ? { enabled: existing.enabled, config: auditConfig(existing.config as Record<string, unknown>), hasSecret: !!existing.secretEncrypted } : null,
      after: { enabled: input.enabled, config: auditConfig(config), secretChanged: input.secret !== undefined },
    });
    return (await this.list(ctx)).find((x) => x.provider === provider);
  }

  /** Internal: the effective settings of a provider, with its secret decrypted. */
  async resolve(provider: IntegrationProvider): Promise<ResolvedIntegration> {
    const [r] = await this.dbs.db.select().from(integrationSettings).where(eq(integrationSettings.provider, provider));
    if (!r) return { enabled: false, config: {}, secret: null };
    // A company that moved to a plan without integrations keeps its settings but they stop working.
    const enabled = r.enabled && (await this.subscription.hasFeature('integrations'));
    return { enabled, config: r.config as ResolvedIntegration['config'], secret: r.secretEncrypted ? decryptSecret(r.secretEncrypted) : null };
  }

  /** A webhook URL set by a company must not reach the platform's own network (SSRF, D-035). */
  async assertSafeUrl(raw: string): Promise<void> {
    try {
      await assertPublicHost(checkOutboundUrl(raw));
    } catch (e) {
      if (e instanceof OutboundUrlError) throw unprocessable('invalid_url', `Webhook URL rejected: ${e.message}`, { field: 'config.url' });
      throw e;
    }
  }
}
