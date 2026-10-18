import { lookup as dnsLookup, LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, LookupFunction } from 'node:net';
import { getEnv } from '../config/env';

/**
 * Outbound HTTP to URLs chosen by a company (webhook gateways), hardened against SSRF:
 * - only globally routable unicast addresses are allowed (IPv4 private/loopback/link-local/CGNAT/
 *   multicast/reserved ranges are refused; for IPv6 only 2000::/3 is allowed, minus documentation,
 *   Teredo and 6to4, which also rules out IPv4-mapped, NAT64, ULA and link-local forms);
 * - the address is checked at connect time, inside the socket's own DNS lookup, so the address
 *   that was checked is the one connected to (no DNS-rebinding window);
 * - redirects are never followed (a 3xx is a failure), so an allowed host cannot bounce the
 *   request to an internal one;
 * - credentials in the URL are refused, and https is required.
 * `OUTBOUND_ALLOW_PRIVATE_HOSTS` (development/test only, refused in production) lifts the address
 * and https rules so local stub gateways work.
 */
const BLOCKED_V4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(net, bits, 'ipv4');

const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) BLOCKED_V6.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !BLOCKED_V4.check(ip, 'ipv4');
  if (v === 6) return GLOBAL_V6.check(ip, 'ipv6') && !BLOCKED_V6.check(ip, 'ipv6');
  return false;
}

export class OutboundUrlError extends Error {}

/** Overrides the environment's policy (used by tests to exercise strict mode). */
export interface OutboundPolicy {
  allowPrivate?: boolean;
}
const allowPrivate = (p?: OutboundPolicy) => p?.allowPrivate ?? getEnv().OUTBOUND_ALLOW_PRIVATE_HOSTS;

/** Static checks on a company-supplied URL (scheme, credentials, literal addresses). */
export function checkOutboundUrl(raw: string, policy?: OutboundPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError('not a valid URL');
  }
  if (url.username || url.password) throw new OutboundUrlError('credentials in the URL are not allowed');
  if (url.protocol !== 'https:' && !(allowPrivate(policy) && url.protocol === 'http:')) throw new OutboundUrlError('the URL must use https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !allowPrivate(policy) && !isPublicAddress(host)) throw new OutboundUrlError('the URL points to a private network address');
  return url;
}

/** Resolves a host name and refuses it unless every address is public. */
export async function assertPublicHost(url: URL, policy?: OutboundPolicy): Promise<void> {
  if (allowPrivate(policy)) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return; // checked by checkOutboundUrl
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, a) => (err ? reject(new OutboundUrlError('the host name does not resolve')) : resolve(a))),
  );
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new OutboundUrlError('the URL points to a private network address');
}

/** The socket's DNS lookup: resolves, then refuses unless every address is public. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new OutboundUrlError('the URL points to a private network address'), '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** POSTs a body and resolves with the HTTP status (never follows redirects; aborts at timeoutMs). */
export async function outboundPost(raw: string, body: string, headers: Record<string, string>, timeoutMs: number, policy?: OutboundPolicy): Promise<number> {
  const url = checkOutboundUrl(raw, policy);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: allowPrivate(policy) ? undefined : guardedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        res.resume(); // the gateway's answer body is not used
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', (e) => reject(e.name === 'AbortError' || e.name === 'TimeoutError' ? new Error(`no answer within ${timeoutMs} ms`) : e));
    req.end(body);
  });
}
