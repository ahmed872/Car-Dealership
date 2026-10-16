import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { PageHeader, Toolbar } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { fmtDateTime } from '@/lib/format';
import { useApi, useApiMutation, useListParams } from '@/lib/hooks';

interface AuditRow {
  id: string;
  seq: number;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  metadata: { requestId?: string; ip?: string } | null;
  createdAt: string;
  actorName: string | null;
  hash: string;
}

export function AuditPage() {
  const { t } = useTranslation();
  const lp = useListParams();
  const q = useApi<{ items: AuditRow[]; total: number }>(['audit'], '/audit-logs', {
    page: lp.page,
    pageSize: 50,
    entityType: lp.get('entityType') || undefined,
  });
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const [result, setResult] = useState<{
    ok: boolean;
    checked: number;
    firstBadSeq: number | null;
    reason: string | null;
  } | null>(null);
  const verify = useApiMutation<
    object,
    { ok: boolean; checked: number; firstBadSeq: number | null; reason: string | null }
  >({
    path: '/audit-logs/verify',
    success: null,
    onSuccess: (r) => setResult(r),
  });
  return (
    <>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        actions={
          <Button
            variant="secondary"
            icon={<ShieldCheck className="h-4 w-4" />}
            loading={verify.isPending}
            onClick={() => verify.mutate({})}
          >
            {t('audit.verify')}
          </Button>
        }
      />
      {result && (
        <Alert
          tone={result.ok ? 'success' : 'danger'}
          className="mb-4"
          title={
            result.ok
              ? t('audit.verifyOk', { count: result.checked })
              : t('audit.verifyFailed', { seq: result.firstBadSeq, reason: result.reason })
          }
        >
          {!result.ok && <ShieldAlert className="inline h-4 w-4" />}
        </Alert>
      )}
      <Card>
        <Toolbar>
          <Input
            className="max-w-xs"
            placeholder={`${t('audit.entity')}: vehicle, sale, payment…`}
            defaultValue={lp.get('entityType')}
            onKeyDown={(e) =>
              e.key === 'Enter' && lp.set({ entityType: (e.target as HTMLInputElement).value.trim() })
            }
          />
        </Toolbar>
        <DataTable
          dense
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          onRowClick={setDetail}
          columns={[
            { key: 'seq', header: '#', cell: (r) => <span className="num text-muted">{r.seq}</span> },
            {
              key: 'at',
              header: t('common.date'),
              cell: (r) => <span className="num text-[13px]">{fmtDateTime(r.createdAt)}</span>,
            },
            { key: 'actor', header: t('audit.actor'), cell: (r) => r.actorName ?? '—' },
            {
              key: 'action',
              header: t('audit.action'),
              cell: (r) => (
                <code className="num rounded bg-surface-2 px-1.5 py-0.5 text-[12px]">{r.action}</code>
              ),
            },
            {
              key: 'summary',
              header: t('common.details'),
              hideOnMobile: true,
              cell: (r) => <span className="line-clamp-1 text-muted">{r.summary ?? r.entityType}</span>,
            },
          ]}
          footer={
            <Pagination
              page={lp.page}
              pageSize={50}
              total={q.data?.total ?? 0}
              onPage={(p) => lp.set({ page: p }, false)}
            />
          }
        />
      </Card>
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.action}
        description={detail && fmtDateTime(detail.createdAt)}
        size="lg"
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <p>{detail.summary}</p>
            <div className="grid gap-3 md:grid-cols-2">
              {(['before', 'after'] as const).map((k) => (
                <div key={k}>
                  <p className="label">{t(`audit.${k}`)}</p>
                  <pre
                    dir="ltr"
                    className="num max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-[12px]"
                  >
                    {JSON.stringify(detail[k], null, 2) ?? '—'}
                  </pre>
                </div>
              ))}
            </div>
            <p className="num text-xs break-all text-subtle" dir="ltr">
              sha256: {detail.hash} · req: {detail.metadata?.requestId} · ip: {detail.metadata?.ip}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
