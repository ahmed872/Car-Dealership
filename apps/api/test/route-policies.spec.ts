import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@autohub/shared';
import { ALLOW_NO_TENANT, AUTHENTICATED_ONLY, IDEMPOTENT, IS_PUBLIC, PERMISSIONS_KEY, PLATFORM_ADMIN } from '../src/common/context';
import { closeApp, getApp } from './helpers';

interface RouteInfo {
  method: string;
  path: string;
  policy: string;
  permissions: string[];
  idempotent: boolean;
}

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
    const discovery = new DiscoveryService(app.get(ModulesContainer));
    const scanner = new MetadataScanner();
    const reflector = new Reflector();
    routes = [];
    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = String(reflector.get<string | string[]>(PATH_METADATA, metatype) ?? '');
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as (...args: unknown[]) => unknown;
        const sub = reflector.get<string | string[]>(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const method = RequestMethod[reflector.get<RequestMethod>(METHOD_METADATA, handler)] ?? '?';
        const pick = <T>(key: string) => reflector.getAllAndOverride<T>(key, [handler, metatype]);
        const perms = pick<string[]>(PERMISSIONS_KEY) ?? [];
        const policy = pick<boolean>(IS_PUBLIC)
          ? 'public'
          : pick<boolean>(PLATFORM_ADMIN)
            ? 'platform_admin'
            : perms.length
              ? 'permissions'
              : pick<boolean>(AUTHENTICATED_ONLY)
                ? 'authenticated'
                : pick<boolean>(ALLOW_NO_TENANT)
                  ? 'signed_in'
                  : 'NONE';
        const path = ['/api/v1', base, String(sub)].join('/').replace(/\/+/g, '/').replace(/\/$/, '');
        routes.push({ method, path, policy, permissions: perms, idempotent: !!pick<boolean>(IDEMPOTENT) });
      }
    }
    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
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
