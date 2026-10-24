import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { WORK_ORDER_PRIORITIES, WORK_ORDER_TYPES } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { isMoney, SupplierLite, useServerFieldErrors } from '@/features/costs/api';
import { PickedVehicle, SupplierPicker, VehiclePicker } from '@/features/costs/components';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useWorkOrderAssignees, WorkOrderDetail, WorkOrderPriority, WorkOrderType } from './api';

const FIELD_FOR_CODE: Record<string, string> = {
  vehicle_closed: 'vehicleId',
  assignee_not_member: 'assignedUserId',
  assignee_no_branch_access: 'assignedUserId',
  supplier_inactive: 'supplierId',
};

/**
 * Create (POST /work-orders) or edit the header (PATCH /work-orders/:id) of a work order. On create,
 * `vehicle` fixes the vehicle (Vehicle 360); otherwise the user searches for one.
 */
export function WorkOrderFormModal({
  wo,
  vehicle: fixedVehicle,
  onClose,
}: {
  wo?: WorkOrderDetail;
  vehicle?: PickedVehicle;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can, currency } = useAuth();
  const sfe = useServerFieldErrors();
  const editing = !!wo;

  const [vehicle, setVehicle] = useState<PickedVehicle | null>(fixedVehicle ?? null);
  const [type, setType] = useState<WorkOrderType>(wo?.type ?? 'repair');
  const [priority, setPriority] = useState<WorkOrderPriority>(wo?.priority ?? 'normal');
  const [title, setTitle] = useState(wo?.title ?? '');
  const [description, setDescription] = useState(wo?.description ?? '');
  const [assignee, setAssignee] = useState(wo?.assignedUserId ?? '');
  const [supplier, setSupplier] = useState<SupplierLite | null>(
    wo?.supplierId ? { id: wo.supplierId, name: wo.supplierName ?? '' } : null,
  );
  const [estimate, setEstimate] = useState(wo?.estimatedCost ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clearError = (k: string) => setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  const [formError, setFormError] = useState<string | null>(null);

  const branchId = editing ? wo!.branchId : vehicle?.branchId;
  const members = useWorkOrderAssignees(branchId);
  const options = members.list;
  const canSupplier = can('suppliers.read');

  const onError = (err: unknown) => {
    const fe = sfe.fromError(err);
    if (err instanceof ApiError && FIELD_FOR_CODE[err.code])
      fe[FIELD_FOR_CODE[err.code]!] = errorMessage(err, t);
    setErrors(fe);
    if (!Object.keys(fe).length) setFormError(errorMessage(err, t));
  };

  const create = useApiMutation<Record<string, unknown>, { id: string }>({
    path: '/work-orders',
    invalidate: [['work-orders'], ['vehicle-work-orders']],
    success: t('workOrders.success.created'),
    onSuccess: (r) => {
      onClose();
      navigate(`/app/work-orders/${r.id}`);
    },
  });
  const update = useApiMutation<Record<string, unknown>>({
    path: `/work-orders/${wo?.id}`,
    method: 'PATCH',
    invalidate: [['work-order', wo?.id], ['work-orders'], ['vehicle-work-orders']],
    success: t('workOrders.success.updated'),
    onSuccess: onClose,
  });

  const submit = () => {
    const e: Record<string, string> = {};
    if (!editing && !vehicle) e.vehicleId = t('costs.validation.required');
    if (title.trim().length < 2) e.title = t('costs.validation.too_short');
    if (estimate.trim() && (!isMoney(estimate) || estimate.trim().startsWith('-')))
      e.estimatedCost = t('costs.validation.invalid_amount');
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = {
      type,
      priority,
      title: title.trim(),
      description: description.trim() || null,
      estimatedCost: estimate.trim() || null,
      assignedUserId: assignee || null,
    };
    // Only send pickers the caller can actually use, so an edit never clears what it cannot see.
    if (canSupplier) body.supplierId = supplier?.id ?? null;
    if (editing) update.mutate(body, { onError });
    else create.mutate({ ...body, vehicleId: vehicle!.id }, { onError });
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? t('workOrders.edit') : t('workOrders.new')}
      description={editing ? `${wo!.number} · ${wo!.vehicle.stockNumber}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={create.isPending || update.isPending} onClick={submit}>
            {editing ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && (
            <div className="sm:col-span-2">
              <VehiclePicker
                label={t('workOrders.vehicle')}
                value={vehicle}
                onChange={(v) => {
                  setVehicle(v);
                  setAssignee('');
                }}
                error={errors.vehicleId}
                blocked={['delivered', 'removed']}
                fixed={!!fixedVehicle}
              />
            </div>
          )}
          <Field label={t('workOrders.titleField')} required error={errors.title} className="sm:col-span-2">
            {(id, desc) => (
              <Input
                id={id}
                aria-describedby={desc}
                invalid={!!errors.title}
                maxLength={200}
                placeholder={t('workOrders.titlePlaceholder')}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  clearError('title');
                }}
              />
            )}
          </Field>
          <Field label={t('workOrders.type')} error={errors.type}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as WorkOrderType)}>
                {WORK_ORDER_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`workOrders.types.${x}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('workOrders.priority')} error={errors.priority}>
            {(id) => (
              <Select
                id={id}
                value={priority}
                onChange={(e) => setPriority(e.target.value as WorkOrderPriority)}
              >
                {WORK_ORDER_PRIORITIES.map((x) => (
                  <option key={x} value={x}>
                    {t(`workOrders.priorities.${x}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('workOrders.assignee')}
            error={errors.assignedUserId}
            hint={t('workOrders.assigneeHint')}
          >
            {(id, desc) => (
              <Select
                id={id}
                aria-describedby={desc}
                invalid={!!errors.assignedUserId}
                value={assignee}
                onChange={(e) => {
                  setAssignee(e.target.value);
                  clearError('assignedUserId');
                }}
              >
                <option value="">
                  {members.isLoading ? t('common.loading') : t('workOrders.unassigned')}
                </option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName}
                  </option>
                ))}
                {/* keep a current assignee visible even if no longer eligible */}
                {assignee && !options.some((m) => m.id === assignee) && editing && (
                  <option value={assignee}>{wo!.assigneeName ?? '—'}</option>
                )}
              </Select>
            )}
          </Field>
          <Field label={t('workOrders.estimate')} error={errors.estimatedCost}>
            {(id, desc) => (
              <MoneyInput
                id={id}
                aria-describedby={desc}
                invalid={!!errors.estimatedCost}
                currency={currency}
                value={estimate}
                onChange={(e) => {
                  setEstimate(e.target.value);
                  clearError('estimatedCost');
                }}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <SupplierPicker
              label={t('workOrders.supplier')}
              hint={t('workOrders.supplierHint')}
              value={supplier}
              onChange={setSupplier}
              error={errors.supplierId}
              disabled={!canSupplier}
            />
          </div>
          <Field label={t('workOrders.description')} error={errors.description} className="sm:col-span-2">
            {(id, desc) => (
              <Textarea
                id={id}
                aria-describedby={desc}
                rows={3}
                maxLength={4000}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  clearError('description');
                }}
              />
            )}
          </Field>
        </div>
      </div>
    </Modal>
  );
}
