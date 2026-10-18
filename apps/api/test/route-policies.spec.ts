import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@autohub/shared';
import { listRoutes, RouteInfo } from './fixtures';
import { closeApp, getApp } from './helpers';

/**
 * The permission matrix (Phase 8): every route declares an access policy (deny by default), every
 * permission it names exists, and the set of routes reachable without a session is exactly the
 * reviewed list below. `WRITE_PERMISSION_MATRIX=1` regenerates docs/PERMISSION_MATRIX.md.
 */
describe('route access policies', () => {
  let app: INestApplication;
  let routes: RouteInfo[];

  beforeAll(async () => {
    app = await getApp();
    routes = listRoutes(app);
    if (process.env.WRITE_PERMISSION_MATRIX === '1') {
      const lines = [
        '# Permission matrix',
        '',
        'Generated from the route metadata by `apps/api/test/route-policies.spec.ts` (`WRITE_PERMISSION_MATRIX=1`).',
        'Policies: `public` (no session), `platform_admin`, `permissions` (ALL listed permissions in the active company),',
        '`authenticated` (any member of the active company), `signed_in` (signed in, no company needed). Branch scope and',
        'ownership rules are enforced inside the services on top of this.',
        '',
        '| Method | Path | Policy | Permissions | Idempotency key |',
        '|---|---|---|---|---|',
        ...routes.map((r) => `| ${r.method} | \`${r.path}\` | ${r.policy} | ${r.permissions.join(', ')} | ${r.idempotent ? 'required' : ''} |`),
        '',
      ];
      writeFileSync(join(__dirname, '../../../docs/PERMISSION_MATRIX.md'), lines.join('\n'));
    }
  });
  afterAll(() => closeApp());

  it('every route declares an access policy', () => {
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.filter((r) => r.policy === 'NONE').map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('every permission a route requires exists', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = routes.flatMap((r) => r.permissions.filter((p) => !known.has(p)).map((p) => `${r.method} ${r.path}: ${p}`));
    expect(unknown).toEqual([]);
  });

  it('only the reviewed routes are reachable without a session', () => {
    const open = routes.filter((r) => r.policy === 'public').map((r) => `${r.method} ${r.path}`);
    expect(open).toEqual([
      'POST /api/v1/auth/login',
      'GET /api/v1/health/live',
      'GET /api/v1/health/ready',
      // Refused unless ALLOW_TENANT_SELF_SIGNUP=true (off by default); 3 per hour per client.
      'POST /api/v1/platform/signup',
      'GET /api/v1/public/showroom/:slug',
      'POST /api/v1/public/showroom/:slug/inquiries',
      'GET /api/v1/public/showroom/:slug/media/:mediaId',
      'GET /api/v1/public/showroom/:slug/vehicles',
      'GET /api/v1/public/showroom/:slug/vehicles/:listingId',
    ]);
  });

  it('platform administration routes are platform-admin only', () => {
    const wrong = routes
      .filter((r) => r.path.startsWith('/api/v1/platform') && r.path !== '/api/v1/platform/signup' && r.policy !== 'platform_admin')
      .map((r) => `${r.method} ${r.path}`);
    expect(wrong).toEqual([]);
  });
});
