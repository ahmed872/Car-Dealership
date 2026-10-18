import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { outboundPost } from '../../common/outbound-http';
import { DbService } from '../../db/db.service';
import { messageLog } from '../../db/schema';
import { SYSTEM_USER_ID } from '../jobs/system-context';
import { IntegrationsService } from './integrations.service';

export interface OutboundMessage {
  channel: 'whatsapp' | 'sms' | 'email';
  to: string;
  text: string;
  relatedType?: string;
  relatedId?: string;
}

/** A message ready to go: the provider settings were read inside the business transaction. */
export interface PreparedMessage {
  tenantId: string;
  tenantSlug: string;
  message: OutboundMessage;
  provider: 'log' | 'webhook';
  url: string | null;
  secret: string | null;
}

/**
 * Outbound customer messages (D-035). Without a configured provider the `log` adapter records the
 * message as `logged` — it is NOT delivered (no WhatsApp/SMS account is connected; EXT-02). The
 * `webhook` adapter posts the message to the company's own gateway, signed with HMAC-SHA256.
 *
 * Sending is split so that no network call happens inside a business transaction (which holds the
 * company's write lock): `prepare` reads the settings inside the transaction, `deliver` runs after
 * it committed — so a rolled-back request never messages anyone — and records the outcome in its
 * own short transaction. Delivery never throws: a failure is recorded as `failed`.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  timeoutMs = 5_000;

  constructor(
    private readonly dbs: DbService,
    private readonly integrations: IntegrationsService,
  ) {}

  /**
   * Inside a tenant transaction: queues the message, to be delivered once (and only if) the
   * transaction commits. The network call happens after the company's write lock is released.
   */
  async send(tenant: { id: string; slug: string }, message: OutboundMessage): Promise<void> {
    const prepared = await this.prepare(tenant, message);
    this.dbs.afterCommit(async () => {
      await this.deliver(prepared);
    });
  }

  /** Inside the tenant transaction: decides the provider for a message. */
  async prepare(tenant: { id: string; slug: string }, message: OutboundMessage): Promise<PreparedMessage> {
    const cfg = await this.integrations.resolve('messaging');
    const webhook = cfg.enabled && cfg.config.provider === 'webhook';
    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      message,
      provider: webhook ? 'webhook' : 'log',
      url: webhook ? String(cfg.config.url ?? '') : null,
      secret: webhook ? cfg.secret : null,
    };
  }

  /** After the business transaction committed: sends (no transaction open) and records the outcome. */
  async deliver(p: PreparedMessage): Promise<'logged' | 'sent' | 'failed'> {
    let status: 'logged' | 'sent' | 'failed' = 'logged';
    let error: string | null = null;
    if (p.provider === 'webhook') {
      try {
        const body = JSON.stringify({ channel: p.message.channel, to: p.message.to, text: p.message.text, tenant: p.tenantSlug });
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (p.secret) headers['x-autohub-signature'] = `sha256=${createHmac('sha256', p.secret).update(body).digest('hex')}`;
        const code = await outboundPost(p.url ?? '', body, headers, this.timeoutMs);
        if (code < 200 || code >= 300) throw new Error(`gateway answered HTTP ${code}`);
        status = 'sent';
      } catch (e) {
        status = 'failed';
        error = (e as Error).message.slice(0, 300);
        this.logger.warn(`message ${p.message.channel} via webhook failed: ${error}`);
      }
    }
    try {
      await this.dbs.runInTenant(
        { tenantId: p.tenantId, userId: SYSTEM_USER_ID },
        () =>
          this.dbs.db.insert(messageLog).values({
            tenantId: p.tenantId,
            channel: p.message.channel,
            recipient: p.message.to,
            body: p.message.text.slice(0, 4000),
            provider: p.provider,
            status,
            error,
            relatedType: p.message.relatedType ?? null,
            relatedId: p.message.relatedId ?? null,
            createdBy: SYSTEM_USER_ID,
          }),
        { write: true },
      );
    } catch (e) {
      this.logger.error(`could not record message for tenant ${p.tenantId}: ${(e as Error).message}`);
    }
    return status;
  }
}
