/**
 * A Content-Disposition header value (RFC 6266) for a download name: `filename` carries an
 * ASCII-only fallback (non-ASCII letters, quotes, separators and control characters become `_`),
 * `filename*` the exact name as UTF-8 (RFC 5987), which current browsers prefer.
 */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  // Path separators and control characters never belong in a download name, in either form.
  const clean = name.replace(/[\p{Cc}/\\]/gu, '_').trim() || 'download';
  const ascii =
    clean
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_') || 'download';
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
