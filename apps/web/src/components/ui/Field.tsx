import clsx from 'clsx';
import {
  forwardRef,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Label + control + hint/error, wired for screen readers (aria-describedby / aria-invalid). */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const { t } = useTranslation();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('min-w-0', className)}>
      {label && (
        <label htmlFor={id} className="label">
          {label}
          {required && (
            <span className="text-danger ms-0.5" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children(id, describedBy)}
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="mt-1 text-xs font-medium text-danger">
          {t(`errors.${error}`, { defaultValue: error })}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input ref={ref} aria-invalid={invalid || undefined} className={clsx('input', className)} {...rest} />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={clsx('input resize-y', className)}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx('input appearance-auto pe-8', className)}
      {...rest}
    >
      {children}
    </select>
  );
});

export const Checkbox = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }
>(function Checkbox({ label, description, className, ...rest }, ref) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx('flex cursor-pointer items-start gap-2.5 text-sm', className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong accent-[var(--brand-strong)]"
        {...rest}
      />
      <span>
        <span className="text-ink">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
});

type AffixInputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

/**
 * Width of an affix tag, measured once it renders (and again if fonts load later). Until then a
 * per-character estimate keeps the first paint close to the final layout.
 */
function useAffixWidth(text: string | undefined) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.offsetWidth || null);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const estimate = `${(text?.length ?? 0) * 0.5 + 0.75}rem`;
  return { ref, width: width ? `${width}px` : estimate };
}

/**
 * A decimal field with a non-editable tag inside its frame. The box is laid out left-to-right in
 * both languages (digits are always LTR), so `start` is the left edge and `end` the right edge
 * whatever the page direction; the padding on the tag's side follows the tag's measured width,
 * so the tag can never cover the digits.
 */
const AffixInput = forwardRef<HTMLInputElement, AffixInputProps & { affix?: string; side: 'start' | 'end' }>(
  function AffixInput({ affix, side, className, invalid, style, ...rest }, ref) {
    const tag = useAffixWidth(affix);
    // 0.75rem from the frame edge to the tag, 0.5rem from the tag to the digits.
    const pad = `calc(${tag.width} + 1.25rem)`;
    return (
      <div className="relative" dir="ltr">
        <input
          ref={ref}
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          aria-invalid={invalid || undefined}
          className={clsx('input num text-start', className)}
          style={affix ? { [side === 'start' ? 'paddingInlineStart' : 'paddingInlineEnd']: pad, ...style } : style}
          {...rest}
        />
        {affix && (
          <span
            ref={tag.ref}
            className={clsx(
              'pointer-events-none absolute inset-y-0 flex items-center text-xs font-medium whitespace-nowrap text-muted',
              side === 'start' ? 'start-3' : 'end-3',
            )}
          >
            {affix}
          </span>
        )}
      </div>
    );
  },
);

/**
 * Decimal money entry: keeps the raw string (never a float) and shows the currency code as a
 * prefix on the left in both languages, matching how amounts read on screen (`SAR 1,500.00` in
 * English; `1,500.00 ر.س` in Arabic, whose symbol also ends up on the left of the figure).
 */
export const MoneyInput = forwardRef<HTMLInputElement, AffixInputProps & { currency?: string }>(
  function MoneyInput({ currency, ...rest }, ref) {
    return <AffixInput ref={ref} affix={currency} side="start" placeholder="0.00" {...rest} />;
  },
);

/** Percentage entry: raw decimal string with a `%` suffix on the right, as `fmtPct` shows it. */
export const PercentInput = forwardRef<HTMLInputElement, AffixInputProps>(function PercentInput(props, ref) {
  return <AffixInput ref={ref} affix="%" side="end" placeholder="0" {...props} />;
});
