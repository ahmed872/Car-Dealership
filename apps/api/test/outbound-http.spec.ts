import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOutboundUrl, isPublicAddress, outboundPost } from '../src/common/outbound-http';

/** SSRF guard for company-supplied webhook URLs (D-035), exercised in strict (production) mode. */
describe('outbound HTTP guard', () => {
  const strict = { allowPrivate: false };
  let server: Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('allows only globally routable addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '192.0.2.10', '198.18.0.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe',
      '2001:db8::1', '2002:a9fe:a9fe::1', '2001:0:4136:e378::1', 'not-an-ip',
    ]) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses http, credentials and private literal addresses', () => {
    expect(() => checkOutboundUrl('http://example.com/hook', strict)).toThrow(/https/);
    expect(() => checkOutboundUrl('https://user:pass@example.com/hook', strict)).toThrow(/credentials/);
    expect(() => checkOutboundUrl('https://169.254.169.254/latest', strict)).toThrow(/private/);
    expect(() => checkOutboundUrl('https://[::ffff:a9fe:a9fe]/', strict)).toThrow(/private/);
    expect(() => checkOutboundUrl('not a url', strict)).toThrow(/valid/);
    expect(checkOutboundUrl('https://example.com/hook', strict).hostname).toBe('example.com');
  });

  it('checks the address at connect time, so a name that resolves to a private address is never contacted', async () => {
    await expect(outboundPost(`https://localhost:${port}/hook`, '{}', {}, 2_000, strict)).rejects.toThrow(/private network/);
    await expect(outboundPost(`http://127.0.0.1:${port}/hook`, '{}', {}, 2_000, strict)).rejects.toThrow(/https/);
    expect(hits).toBe(0);
    // With the development/test allowance the same local gateway is reachable.
    expect(await outboundPost(`http://127.0.0.1:${port}/hook`, '{}', {}, 2_000, { allowPrivate: true })).toBe(200);
    expect(hits).toBe(1);
  });
});
