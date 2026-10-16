import clsx from 'clsx';
import { ArrowDown, ArrowUp, Eye, EyeOff, FileText, Lock, Plus, Star, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { DOC_TYPES, MEDIA_CATEGORIES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, errorMessage } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fileUrl, Media, VehicleDetail } from './api';

export function MediaTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [category, setCategory] = useState('general');
  const [deleting, setDeleting] = useState<Media | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const vid = d.vehicle.id;
  const refresh = () => qc.invalidateQueries({ queryKey: ['vehicle', vid] });
  const editable = can('vehicles.manage_media') && !['delivered', 'removed'].includes(d.vehicle.status);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    setUploading(list.length);
    for (const f of list) {
      const form = new FormData();
      form.append('category', category);
      form.append('file', f);
      try {
        await api(`/vehicles/${vid}/media`, { method: 'POST', form });
      } catch (e) {
        toast.error(`${f.name}: ${errorMessage(e, t)}`);
      }
      setUploading((n) => n - 1);
    }
    setUploading(0);
    await refresh();
  };
  const patch = useApiMutation<{ mediaId: string; body: Record<string, unknown> }>({
    path: (v) => `/vehicles/${vid}/media/${v.mediaId}`,
    method: 'PATCH',
    body: (v) => v.body,
    invalidate: [['vehicle', vid]],
    success: null,
  });
  const reorder = useApiMutation<{ mediaIds: string[] }>({ path: `/vehicles/${vid}/media/order`, method: 'PUT', invalidate: [['vehicle', vid]], success: null });
  const del = useApiMutation<{ mediaId: string }>({
    path: (v) => `/vehicles/${vid}/media/${v.mediaId}`,
    method: 'DELETE',
    invalidate: [['vehicle', vid]],
    success: t('common.deletedSuccessfully'),
    onSuccess: () => setDeleting(null),
  });
  const move = (idx: number, dir: -1 | 1) => {
    const ids = d.media.map((m) => m.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    reorder.mutate({ mediaIds: ids });
  };

  return (
    <div className="space-y-4">
      {editable && (
        <Card>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
            }}
            className={clsx('m-4 flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition', dragOver ? 'border-brand bg-brand-soft/40' : 'border-line')}
          >
            <Upload className="h-6 w-6 text-muted" aria-hidden />
            <p className="text-sm text-muted">{t('vehicles.media.dropHint')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Select className="w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('vehicles.media.category')}>
                {MEDIA_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`vehicles.enums.mediaCategory.${c}`)}
                  </option>
                ))}
              </Select>
              <Button icon={<Plus className="h-4 w-4" />} loading={uploading > 0} onClick={() => inputRef.current?.click()}>
                {uploading > 0 ? t('vehicles.media.uploading', { count: uploading }) : t('vehicles.media.upload')}
              </Button>
              <input
                ref={inputRef}
                type="file"
                hidden
                multiple
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
                onChange={(e) => {
                  if (e.target.files?.length) void upload(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="text-xs text-subtle">{t('vehicles.media.privacyNote')}</p>
          </div>
        </Card>
      )}
      {d.media.length === 0 ? (
        <Card>
          <EmptyState title={t('vehicles.media.empty')} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {d.media.map((m, i) => (
            <figure key={m.id} className="card overflow-hidden">
              <div className="relative aspect-[4/3] bg-surface-2">
                {m.kind === 'photo' ? (
                  <img src={fileUrl(m.fileId)} alt={m.caption ?? ''} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <video src={fileUrl(m.fileId)} controls preload="metadata" className="h-full w-full object-cover" />
                )}
                <div className="absolute start-2 top-2 flex gap-1">
                  {m.isPrimary && <Badge tone="brand">{t('vehicles.media.primary')}</Badge>}
                  <Badge tone={m.isPublic ? 'success' : 'neutral'}>{m.isPublic ? t('vehicles.media.public') : t('vehicles.media.private')}</Badge>
                </div>
              </div>
              <figcaption className="space-y-2 p-3">
                <p className="text-xs text-muted">
                  {t(`vehicles.enums.mediaCategory.${m.category}`)}
                  {m.caption && ` · ${m.caption}`}
                </p>
                {editable && (
                  <div className="flex flex-wrap gap-1">
                    {m.kind === 'photo' && !m.isPrimary && (
                      <Button size="sm" variant="ghost" icon={<Star className="h-3.5 w-3.5" />} onClick={() => patch.mutate({ mediaId: m.id, body: { isPrimary: true } })}>
                        {t('vehicles.media.setPrimary')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={m.isPublic ? t('vehicles.media.private') : t('vehicles.media.public')}
                      icon={m.isPublic ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      onClick={() => patch.mutate({ mediaId: m.id, body: { isPublic: !m.isPublic } })}
                    />
                    <Button size="sm" variant="ghost" title={t('vehicles.media.moveUp')} disabled={i === 0} icon={<ArrowUp className="h-3.5 w-3.5" />} onClick={() => move(i, -1)} />
                    <Button size="sm" variant="ghost" title={t('vehicles.media.moveDown')} disabled={i === d.media.length - 1} icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={() => move(i, 1)} />
                    <Button size="sm" variant="ghost" title={t('common.delete')} icon={<Trash2 className="h-3.5 w-3.5 text-danger" />} onClick={() => setDeleting(m)} />
                  </div>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title={t('common.delete')} tone="danger" loading={del.isPending} onConfirm={() => {
          if (deleting) del.mutate({ mediaId: deleting.id });
        }} />
    </div>
  );
}

function expiryBadge(expiresAt: string | null, t: (k: string) => string) {
  if (!expiresAt) return null;
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <Badge tone="danger">{t('vehicles.documents.expired')}</Badge>;
  if (days <= 30) return <Badge tone="warning">{t('vehicles.documents.expiresSoon')}</Badge>;
  return <Badge tone="success">{t('vehicles.documents.valid')}</Badge>;
}

function AddDocument({ vid, onDone }: { vid: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ docType: 'registration', docNumber: '', issuedAt: '', expiresAt: '', isSensitive: false, notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const submit = async () => {
    setBusy(true);
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, String(v));
    if (file) fd.append('file', file);
    try {
      await api(`/vehicles/${vid}/documents`, { method: 'POST', form: fd });
      await qc.invalidateQueries({ queryKey: ['vehicle', vid] });
      toast.success(t('common.savedSuccessfully'));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('vehicles.documents.type')}>
        {(id) => (
          <Select id={id} value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {t(`vehicles.enums.docType.${d}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('vehicles.documents.number')}>{(id) => <Input id={id} dir="ltr" value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} />}</Field>
      <Field label={t('vehicles.documents.issuedAt')}>{(id) => <Input id={id} type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} />}</Field>
      <Field label={t('vehicles.documents.expiresAt')}>{(id) => <Input id={id} type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />}</Field>
      <Field label={t('vehicles.documents.file')} className="sm:col-span-2">
        {(id) => <Input id={id} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
      </Field>
      <Field label={t('common.notes')} className="sm:col-span-2">
        {(id) => <Textarea id={id} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}
      </Field>
      {can('documents.read_sensitive') && (
        <Checkbox className="sm:col-span-2" label={t('vehicles.documents.sensitive')} checked={form.isSensitive} onChange={(e) => setForm({ ...form, isSensitive: e.target.checked })} />
      )}
      <div className="flex justify-end sm:col-span-2">
        <Button loading={busy} onClick={submit}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

export function DocumentsTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const vid = d.vehicle.id;
  const del = useApiMutation<{ docId: string; reason: string }>({
    path: (v) => `/vehicles/${vid}/documents/${v.docId}/delete`,
    body: (v) => ({ reason: v.reason }),
    invalidate: [['vehicle', vid]],
    success: t('common.deletedSuccessfully'),
    onSuccess: () => setDeleting(null),
  });
  return (
    <Card>
      <CardHeader
        title={t('vehicles.tabs.documents')}
        actions={
          <Can perm="vehicles.manage_documents">
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              {t('vehicles.documents.add')}
            </Button>
          </Can>
        }
      />
      <DataTable
        rows={d.documents}
        rowKey={(r) => r.id}
        empty={<EmptyState icon={<FileText className="h-5 w-5" />} title={t('vehicles.documents.empty')} />}
        columns={[
          {
            key: 'type',
            header: t('vehicles.documents.type'),
            cell: (r) => (
              <span className="inline-flex items-center gap-2 font-medium">
                {t(`vehicles.enums.docType.${r.docType}`)}
                {r.isSensitive && <Lock className="h-3.5 w-3.5 text-warning" aria-label={t('vehicles.documents.sensitive')} />}
              </span>
            ),
          },
          { key: 'num', header: t('vehicles.documents.number'), cell: (r) => (r.restricted ? <Badge tone="neutral">{t('vehicles.documents.restricted')}</Badge> : <span className="num">{r.docNumber ?? '—'}</span>) },
          { key: 'exp', header: t('vehicles.documents.expiresAt'), cell: (r) => <span className="inline-flex items-center gap-2">{fmtDate(r.expiresAt)} {expiryBadge(r.expiresAt, t)}</span> },
          {
            key: 'file',
            header: t('common.download'),
            cell: (r) =>
              r.fileId ? (
                <a href={fileUrl(r.fileId)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-strong hover:underline">
                  {t('common.open')}
                </a>
              ) : (
                <span className="text-xs text-subtle">{r.restricted ? '🔒' : t('vehicles.documents.noFile')}</span>
              ),
          },
          {
            key: 'actions',
            header: <span className="sr-only">{t('common.actions')}</span>,
            align: 'end',
            cell: (r) => (
              <Can perm="vehicles.manage_documents">
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-danger" />} onClick={() => setDeleting(r.id)} aria-label={t('common.delete')} />
              </Can>
            ),
          },
        ]}
      />
      <Modal open={adding} onClose={() => setAdding(false)} title={t('vehicles.documents.add')}>
        {adding && <AddDocument vid={vid} onDone={() => setAdding(false)} />}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t('common.delete')}
        tone="danger"
        requireReason
        loading={del.isPending}
        onConfirm={(reason) => {
          if (deleting) del.mutate({ docId: deleting, reason });
        }}
      />
      {d.documents.some((x) => x.restricted) && (
        <div className="p-4">
          <Alert tone="info">{t('vehicles.documents.sensitive')}</Alert>
        </div>
      )}
    </Card>
  );
}
