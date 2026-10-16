import clsx from 'clsx';
import {
  Building,
  ChevronDown,
  Languages,
  LogOut,
  Menu,
  Moon,
  ShieldCheck,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { currentLang, setLanguage } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { NAV } from './nav';

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('ah.theme', next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
    setDark(next);
  };
  return [dark, toggle];
}

export function BrandMark({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-brand-ink shadow-sm">
        <svg viewBox="0 0 64 64" className="h-6 w-6" aria-hidden>
          <path
            d="M10 40l6-14c1-3 4-5 7-5h18c3 0 6 2 7 5l6 14v6a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-2H17v2a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2z"
            fill="currentColor"
          />
          <circle cx="20" cy="38" r="3.4" fill="#fff4dc" />
          <circle cx="44" cy="38" r="3.4" fill="#fff4dc" />
        </svg>
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[15px] font-bold tracking-tight text-white">{t('app.name')}</span>
          <span className="block text-[11px] text-nav-ink/70">{t('app.tagline')}</span>
        </span>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { me, canAny } = useAuth();
  return (
    <nav aria-label="main" className="flex h-full flex-col bg-nav text-nav-ink">
      <div className="flex h-16 items-center px-5">
        <BrandMark />
      </div>
      {me?.tenant && (
        <div className="mx-3 mb-3 rounded-xl bg-white/5 px-3 py-2.5">
          <p className="truncate text-[13px] font-semibold text-white">{me.tenant.name}</p>
          <p className="truncate text-[11px] text-nav-ink/70">
            {t(`markets.${me.tenant.market}`)} · {me.tenant.baseCurrency}
          </p>
        </div>
      )}
      <div className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.anyOf || canAny(...i.anyOf));
          if (!items.length) return null;
          return (
            <div key={group.labelKey}>
              <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-nav-ink/50 uppercase">
                {t(group.labelKey)}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        clsx(
                          'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors',
                          isActive
                            ? 'bg-white/10 font-medium text-white'
                            : 'hover:bg-white/5 hover:text-white',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon
                            className={clsx(
                              'h-[18px] w-[18px] shrink-0',
                              isActive ? 'text-brand' : 'text-nav-ink/70 group-hover:text-white',
                            )}
                          />
                          <span className="truncate">{t(item.labelKey)}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {me?.user.isPlatformAdmin && (
          <div>
            <NavLink
              to="/platform"
              onClick={onNavigate}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] hover:bg-white/5 hover:text-white"
            >
              <ShieldCheck className="h-[18px] w-[18px] text-nav-ink/70" />
              {t('nav.platform')}
            </NavLink>
          </div>
        )}
      </div>
    </nav>
  );
}

function Menu_({ trigger, children }: { trigger: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className="animate-in absolute end-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  tone,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 px-3.5 py-2 text-start text-sm hover:bg-surface-2',
        tone === 'danger' ? 'text-danger' : 'text-ink',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t } = useTranslation();
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [dark, toggleTheme] = useTheme();
  const lang = currentLang();
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface/85 px-4 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={onMenu}
        className="rounded-lg p-2 text-muted hover:bg-surface-2 lg:hidden"
        aria-label="menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div id="topbar-slot" className="min-w-0 flex-1" />
      <button
        type="button"
        onClick={() => setLanguage(lang === 'ar' ? 'en' : 'ar')}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-ink"
        title={t('common.language')}
        lang={lang === 'ar' ? 'en' : 'ar'}
      >
        <Languages className="h-4 w-4" />
        {lang === 'ar' ? 'English' : 'العربية'}
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-ink"
        aria-label={t('common.theme')}
      >
        {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
      </button>
      <Menu_
        trigger={
          <span className="flex items-center gap-2 rounded-lg py-1.5 ps-1.5 pe-2 hover:bg-surface-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-strong">
              {me?.user.fullName.slice(0, 1)}
            </span>
            <span className="hidden text-start leading-tight sm:block">
              <span className="block max-w-[160px] truncate text-[13px] font-medium text-ink">
                {me?.user.fullName}
              </span>
              <span className="block max-w-[160px] truncate text-[11px] text-muted">{me?.role?.name}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted" />
          </span>
        }
      >
        {(close) => (
          <>
            <div className="border-b border-line px-3.5 py-2.5">
              <p className="truncate text-sm font-medium">{me?.user.fullName}</p>
              <p className="truncate text-xs text-muted">{me?.user.email}</p>
            </div>
            <MenuItem
              icon={<UserRound className="h-4 w-4 text-muted" />}
              onClick={() => (close(), navigate('/app/account'))}
            >
              {t('nav.account')}
            </MenuItem>
            {(me?.tenants.length ?? 0) > 1 && (
              <MenuItem
                icon={<Building className="h-4 w-4 text-muted" />}
                onClick={() => (close(), navigate('/select-company'))}
              >
                {t('auth.switchCompany')}
              </MenuItem>
            )}
            <MenuItem
              tone="danger"
              icon={<LogOut className="h-4 w-4" />}
              onClick={async () => {
                close();
                await signOut();
                navigate('/login', { replace: true });
              }}
            >
              {t('auth.signOut')}
            </MenuItem>
          </>
        )}
      </Menu_>
    </header>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <div className="min-h-screen lg:ps-[264px]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-brand focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[264px] lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="animate-in absolute inset-y-0 start-0 w-[280px] max-w-[85vw]">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute end-2 top-4 z-10 rounded-lg p-2 text-white/80"
              aria-label="close"
            >
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <Topbar onMenu={() => setMobileOpen(true)} />
      <main id="main" className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
