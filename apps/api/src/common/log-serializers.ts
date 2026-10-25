/**
 * pino-http request serializer: logs the path without its query string, and no parsed `query`.
 * Query parameters can carry personal data (a phone or email to search for, a name filter), and
 * request logs are kept longer and read more widely than the database (D-054). Anything a route
 * needs to log must be logged explicitly, never through the URL.
 */
export function logRequestSerializer(req: Record<string, unknown>): Record<string, unknown> {
  // `raw` is the original request kept by pino-std-serializers (non-enumerable, never logged).
  const { query: _query, ...rest } = req;
  const url = typeof req.url === 'string' ? req.url.split('?')[0] : req.url;
  return { ...rest, url };
}
