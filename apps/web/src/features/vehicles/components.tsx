import clsx from 'clsx';
import { Car, ImageOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PANEL_CODES, PanelCode, PanelCondition, VEHICLE_STATUS_LABELS, VehicleStatus } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { useAuth } from '@/lib/auth';
import { fileUrl } from './api';

const toneMap: Record<string, Tone> = { info: 'info', success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral', accent: 'accent' };

/** Status label honours tenant-specific label overrides (settings.statusLabels). */
export function useStatusLabel() {
  const { i18n } = useTranslation();
  const { me } = useAuth();
  return (s: VehicleStatus) => {
    const custom = me?.tenant?.settings.statusLabels?.[s];
    const lang = i18n.language === 'en' ? 'en' : 'ar';
    return custom?.[lang] || VEHICLE_STATUS_LABELS[s][lang];
  };
}

export function VehicleStatusBadge({ status }: { status: VehicleStatus }) {
  const label = useStatusLabel();
  return <Badge tone={toneMap[VEHICLE_STATUS_LABELS[status].tone] ?? 'neutral'}>{label(status)}</Badge>;
}

export function vehicleTitle(
  v: { modelYear: number; makeNameEn?: string; makeNameAr?: string; modelNameEn?: string; modelNameAr?: string; trim?: string | null },
  lang: string,
): string {
  const make = lang === 'en' ? v.makeNameEn : v.makeNameAr;
  const model = lang === 'en' ? v.modelNameEn : v.modelNameAr;
  return [make, model, v.trim, v.modelYear].filter(Boolean).join(' ');
}

export function VehiclePhoto({ fileId, alt, className }: { fileId: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!fileId || failed) {
    return (
      <div className={clsx('flex items-center justify-center bg-surface-2 text-subtle', className)} aria-label={alt}>
        {failed ? <ImageOff className="h-8 w-8" /> : <Car className="h-10 w-10" />}
      </div>
    );
  }
  return <img src={fileUrl(fileId)} alt={alt} loading="lazy" onError={() => setFailed(true)} className={clsx('object-cover', className)} />;
}

// ── Body diagram ─────────────────────────────────────────────────────────────────────────
export const PANEL_STYLE: Record<PanelCondition, { fill: string; code: string }> = {
  original: { fill: '#16a34a', code: 'O' },
  repainted: { fill: '#f59e0b', code: 'P' },
  filler: { fill: '#ea580c', code: 'F' },
  repaired: { fill: '#2563eb', code: 'R' },
  damaged: { fill: '#dc2626', code: 'D' },
  replaced: { fill: '#7c3aed', code: 'X' },
  scratched: { fill: '#ca8a04', code: 'S' },
  dented: { fill: '#be185d', code: 'T' },
  not_inspected: { fill: '#94a3b8', code: '?' },
};

/** Top-down car. Front points up. Coordinates in a 200×420 box; labels are centred per panel. */
const PANELS: Record<PanelCode, { d: string; lx: number; ly: number }> = {
  front_bumper: { d: 'M52 18 Q100 4 148 18 L150 40 L50 40 Z', lx: 100, ly: 29 },
  hood: { d: 'M54 44 L146 44 L150 118 L50 118 Z', lx: 100, ly: 84 },
  fl_fender: { d: 'M22 52 L48 44 L46 120 L20 120 Z', lx: 34, ly: 86 },
  fr_fender: { d: 'M178 52 L152 44 L154 120 L180 120 Z', lx: 166, ly: 86 },
  roof: { d: 'M58 158 L142 158 L142 278 L58 278 Z', lx: 100, ly: 218 },
  fl_door: { d: 'M20 124 L46 124 L46 206 L20 206 Z', lx: 33, ly: 165 },
  fr_door: { d: 'M154 124 L180 124 L180 206 L154 206 Z', lx: 167, ly: 165 },
  rl_door: { d: 'M20 210 L46 210 L46 292 L20 292 Z', lx: 33, ly: 251 },
  rr_door: { d: 'M154 210 L180 210 L180 292 L154 292 Z', lx: 167, ly: 251 },
  rl_quarter: { d: 'M20 296 L46 296 L48 372 L24 364 Z', lx: 34, ly: 334 },
  rr_quarter: { d: 'M180 296 L154 296 L152 372 L176 364 Z', lx: 166, ly: 334 },
  trunk: { d: 'M52 318 L148 318 L148 374 L52 374 Z', lx: 100, ly: 346 },
  rear_bumper: { d: 'M50 380 L150 380 L148 402 Q100 414 52 402 Z', lx: 100, ly: 392 },
};

export function CarDiagram({
  panels,
  selected,
  onSelect,
  readOnly,
}: {
  panels: Record<string, PanelCondition>;
  selected?: string | null;
  onSelect?: (code: PanelCode) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 200 420" className="mx-auto h-auto w-full max-w-[260px]" role="group" aria-label={t('vehicles.inspections.bodyDiagram')}>
      {/* windshields & glass (not selectable) */}
      <path d="M56 124 L144 124 L140 154 L60 154 Z" className="fill-sky-200/60 stroke-line-strong dark:fill-sky-900/40" strokeWidth="1" />
      <path d="M60 282 L140 282 L144 312 L56 312 Z" className="fill-sky-200/60 stroke-line-strong dark:fill-sky-900/40" strokeWidth="1" />
      {PANEL_CODES.map((code) => {
        const cond = panels[code] ?? 'not_inspected';
        const style = PANEL_STYLE[cond];
        const p = PANELS[code];
        const label = `${t(`vehicles.enums.panel.${code}`)}: ${t(`vehicles.enums.panelCondition.${cond}`)}`;
        return (
          <g
            key={code}
            role={readOnly ? 'img' : 'button'}
            tabIndex={readOnly ? -1 : 0}
            aria-label={label}
            aria-pressed={!readOnly ? selected === code : undefined}
            onClick={() => !readOnly && onSelect?.(code)}
            onKeyDown={(e) => {
              if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onSelect?.(code);
              }
            }}
            className={clsx(!readOnly && 'cursor-pointer focus:outline-none')}
          >
            <title>{label}</title>
            <path
              d={p.d}
              fill={style.fill}
              fillOpacity={cond === 'not_inspected' ? 0.25 : 0.75}
              stroke={selected === code ? 'var(--ink)' : 'var(--surface)'}
              strokeWidth={selected === code ? 3 : 1.5}
            />
            {/* Letter code: condition is readable without colour */}
            <text x={p.lx} y={p.ly + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" style={{ pointerEvents: 'none' }}>
              {style.code}
            </text>
          </g>
        );
      })}
      {/* wheels */}
      {[
        [10, 80],
        [180, 80],
        [10, 316],
        [180, 316],
      ].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="10" height="40" rx="3" className="fill-ink/70" />
      ))}
    </svg>
  );
}

export function PanelLegend() {
  const { t } = useTranslation();
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      {(Object.keys(PANEL_STYLE) as PanelCondition[]).map((c) => (
        <li key={c} className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: PANEL_STYLE[c].fill }}>
            {PANEL_STYLE[c].code}
          </span>
          {t(`vehicles.enums.panelCondition.${c}`)}
        </li>
      ))}
    </ul>
  );
}
