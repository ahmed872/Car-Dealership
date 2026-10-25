import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { d, money, WORK_ORDER_ITEM_KINDS } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import {
  categoryName,
  isMoney,
  SupplierLite,
  useServerFieldErrors,
  useTenantDefaults,
  useVehicleCategories,
} from '@/features/costs/api';
import { SupplierPicker } from '@/features/costs/components';
import { ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { useApiMutation } from '@/lib/hooks';
import { WorkOrderDetail, WorkOrderItem, WorkOrderItemKind } from './api';

const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const HOURS_RE = /^\d{1,4}(\.\d{1,2})?$/;

const FIELD_FOR_CODE: Record<string, string> = {
  invalid_quantity: 'quantity',
  supplier_inactive: 'supplierId',
  category_not_vehicle: 'categoryId',
  purchase_via_acquisition: 'categoryId',
};

/** Add (POST …/items) or edit (PATCH …/items/:itemId) a work order line. Amounts are in base currency. */
export function WorkOrderItemModal({
  wo,
  item,
  onClose,
}: {
  wo: WorkOrderDetail;
  item?: WorkOrderItem;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { rounding, base } = useTenantDefaults();
  const cats = useVehicleCategories();
  const sfe = useServerFieldErrors();
  const [kind, setKind] = useState<WorkOrderItemKind>(item?.kind ?? 'part');
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [supplier, setSupplier] = useState<SupplierLite | null>(
    item?.supplierId ? { id: item.supplierId, name: item.supplierName ?? '' } : null,
  );
  const [quantity, setQuantity] = useState(item ? d(item.quantity).toString() : '1');
  const [unitCost, setUnitCost] = useState(item?.unitCost ?? '');
  const [hours, setHours] = useState(item?.hours ? d(item.hours).toString() : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clearError = (k: string) => setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  const [formError, setFormError] = useState<string | null>(null);

  const qtyOk = QTY_RE.test(quantity.trim()) && d(quantity.trim()).gt(0);
  const unitOk = isMoney(unitCost) && !unitCost.trim().startsWith('-');
  const total = qtyOk && unitOk ? money(d(quantity.trim()).times(d(unitCost.trim())), base, rounding) : null;

  const invalidate = [['work-order', wo.id], ['work-orders'], ['vehicle-work-orders', wo.vehicleId]];
  const onError = (err: unknown) => {
    const fe = sfe.fromError(err);
    if (err instanceof ApiError && FIELD_FOR_CODE[err.code])
      fe[FIELD_FOR_CODE[err.code]!] = errorMessage(err, t);
    setErrors(fe);
    if (!Object.keys(fe).length) setFormError(errorMessage(err, t));
  };
  const add = useApiMutation<Record<string, unknown>>({
    path: `/work-orders/${wo.id}/items`,
    invalidate,
    success: t('workOrders.success.itemSaved'),
    onSuccess: onClose,
  });
  const edit = useApiMutation<Record<string, unknown>>({
    path: `/work-orders/${wo.id}/items/${item?.id}`,
    method: 'PATCH',
    invalidate,
    success: t('workOrders.success.itemSaved'),
    onSuccess: onClose,
  });

  const submit = () => {
    const e: Record<string, string> = {};
    if (description.trim().length < 2) e.description = t('costs.validation.too_short');
    if (!categoryId) e.categoryId = t('costs.validation.required');
    if (!qtyOk) e.quantity = t('costs.validation.invalid_quantity');
    if (!unitCost.trim()) e.unitCost = t('costs.validation.required');
    else if (!unitOk) e.unitCost = t('costs.validation.invalid_amount');
    if (hours.trim() && !HOURS_RE.test(hours.trim())) e.hours = t('costs.validation.invalid_value');
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    const body = {
      kind,
      description: description.trim(),
      categoryId,
      supplierId: supplier?.id ?? null,
      quantity: quantity.trim(),
      unitCost: unitCost.trim(),
      hours: hours.trim() || null,
    };
    if (item) edit.mutate(body, { onError });
    else add.mutate(body, { onError });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? t('workOrders.items.edit') : t('workOrders.items.add')}
      description={`${wo.number} · ${t('workOrders.items.currencyNote', { currency: base })}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={add.isPending || edit.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('workOrders.items.kind')}>
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as WorkOrderItemKind)}>
                {WORK_ORDER_ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`workOrders.kinds.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('workOrders.items.category')} required error={errors.categoryId}>
            {(id, desc) => (
              <Select
                id={id}
                aria-describedby={desc}
                invalid={!!errors.categoryId}
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  clearError('categoryId');
                }}
              >
                <option value="">
                  {cats.isLoading ? t('common.loading') : t('costs.form.categoryPlaceholder')}
                </option>
                {cats.list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c, i18n.language)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('workOrders.items.description')}
            required
            error={errors.description}
            className="sm:col-span-2"
          >
            {(id, desc) => (
              <Input
                id={id}
                aria-describedby={desc}
                invalid={!!errors.description}
                maxLength={300}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  clearError('description');
                }}
              />
            )}
          </Field>
          <Field label={t('workOrders.items.quantity')} required error={errors.quantity}>
            {(id, desc) => (
              <Input
                id={id}
                dir="ltr"
                inputMode="decimal"
                className="num"
                aria-describedby={desc}
                invalid={!!errors.quantity}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  clearError('quantity');
                }}
              />
            )}
          </Field>
          <Field label={t('workOrders.items.unitCost')} required error={errors.unitCost}>
            {(id, desc) => (
              <MoneyInput
                id={id}
                aria-describedby={desc}
                invalid={!!errors.unitCost}
                currency={base}
                value={unitCost}
                onChange={(e) => {
                  setUnitCost(e.target.value);
                  clearError('unitCost');
                }}
              />
            )}
          </Field>
          <Field label={t('workOrders.items.hours')} error={errors.hours} hint={t('common.optional')}>
            {(id, desc) => (
              <Input
                id={id}
                dir="ltr"
                inputMode="decimal"
                className="num"
                aria-describedby={desc}
                invalid={!!errors.hours}
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value);
                  clearError('hours');
                }}
              />
            )}
          </Field>
          <div className="flex items-end">
            <p
              className="num w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
              aria-live="polite"
            >
              {t('workOrders.items.totalPreview', { total: total ? fmtMoney(total, base) : '—' })}
            </p>
          </div>
          <div className="sm:col-span-2">
            <SupplierPicker
              label={t('workOrders.items.supplier')}
              hint={
                wo.supplierName
                  ? t('workOrders.items.supplierInherit', { name: wo.supplierName })
                  : t('workOrders.items.supplierNone')
              }
              value={supplier}
              onChange={setSupplier}
              error={errors.supplierId}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
