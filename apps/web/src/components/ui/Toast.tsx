import clsx from 'clsx';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

const ToastCtx = createContext<{ push: (tone: ToastTone, message: ReactNode) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: ToastTone, message: ReactNode) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pe-6"
      >
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info;
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                'animate-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-pop',
                t.tone === 'success' && 'border-success/30',
                t.tone === 'error' && 'border-danger/30',
                t.tone === 'info' && 'border-line',
              )}
            >
              <Icon
                className={clsx(
                  'mt-0.5 h-4 w-4 shrink-0',
                  t.tone === 'success' ? 'text-success' : t.tone === 'error' ? 'text-danger' : 'text-info',
                )}
              />
              <div className="min-w-0 flex-1 text-ink">{t.message}</div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-subtle hover:text-ink"
                aria-label="close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return {
    success: (m: ReactNode) => ctx.push('success', m),
    error: (m: ReactNode) => ctx.push('error', m),
    info: (m: ReactNode) => ctx.push('info', m),
  };
}
