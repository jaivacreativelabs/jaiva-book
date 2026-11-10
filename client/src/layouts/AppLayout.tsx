import {
  Building2,
  ChartColumn,
  ChartLine,
  CheckCheck,
  ChefHat,
  ChevronDown,
  CircleCheck,
  CirclePlus,
  ClipboardList,
  CloudOff,
  FileText,
  History,
  KeyRound,
  LogOut,
  Mail,
  Menu as MenuIcon,
  MonitorPlay,
  ConciergeBell,
  Search,
  Store,
  UserRound,
  Users,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { TableIcon } from '../components/badges';
import { ShopClosedNotice, ShopToggle } from '../components/ShopToggle';
import { Loading } from '../components/ui';
import { useRootClass } from '../hooks/useRootClass';
import { FoodAlerts } from '../components/FoodAlerts';
import { ChangePasswordModal } from '../pages/auth/ChangePasswordModal';
import { useAuth } from '../store/auth';
import { APP_NAME, placeName } from '@rb/shared';
import { getSyncSummary, subscribeSyncSummary } from '../store/draftSync';
import { useToast } from '../store/toast';
import { useTopbar } from '../store/topbar';
import { cx } from '../utils/format';
import { ROLE_LABEL } from '../utils/roles';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  primary?: boolean;
  end?: boolean;
}

const RESTAURANT_NAV: NavItem[] = [
  { to: '/billing', label: 'New Bill', icon: CirclePlus, primary: true },
  { to: '/menu', label: 'Menu', icon: Utensils },
  { to: '/transactions', label: 'Transactions', icon: FileText },
  { to: '/tables', label: 'Tables', icon: TableIcon },
  { to: '/expenses', label: 'Expenses', icon: Wallet },
];
// Shown only when the Super Admin has switched the Kitchen Display on for the restaurant.
const KITCHEN_NAV: NavItem = { to: '/kitchen', label: 'Kitchen', icon: ChefHat };
// Food the kitchen marked Ready (also needs the Kitchen Display).
const WAITER_NAV: NavItem = { to: '/waiter', label: 'Ready to Serve', icon: ConciergeBell, end: true };
// Orders served at the table or handed over at the counter (every login of the branch).
const SERVED_NAV: NavItem = { to: '/served', label: 'Served', icon: CheckCheck };
// Waiter logins: taking table orders (they never bill).
const TAKE_ORDER_NAV: NavItem = { to: '/waiter/order', label: 'Take Order', icon: ClipboardList };

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/restaurants', label: 'Restaurants', icon: Store },
  { to: '/admin/users', label: 'Employees', icon: Users },
  { to: '/admin/menu', label: 'Menu', icon: Utensils },
  { to: '/admin/transactions', label: 'Transactions', icon: FileText },
  { to: '/admin/served', label: 'Served Orders', icon: CheckCheck },
  { to: '/admin/expenses', label: 'Expenses', icon: Wallet },
  { to: '/admin/reports', label: 'Reports', icon: ChartLine },
  { to: '/admin/analytics', label: 'Analytics', icon: ChartColumn },
  { to: '/admin/daily-report', label: 'Daily Report', icon: Mail },
  { to: '/admin/audit', label: 'Audit Log', icon: History },
  { to: '/admin/demo-logins', label: 'Demo Logins', icon: MonitorPlay },
];

function SyncIndicator() {
  const { pending, failing } = useSyncExternalStore(subscribeSyncSummary, getSyncSummary);
  if (failing > 0) {
    return (
      <span className="sync-pill error" title="Some bill changes could not be saved yet. They are kept and retried automatically.">
        <CloudOff size={16} /> {failing}
        <span className="sync-text">
          {' '}
          bill{failing > 1 ? 's' : ''} not saved – retrying
        </span>
      </span>
    );
  }
  if (pending > 0) return <span className="sync-pill">Saving…</span>;
  return null;
}

function UserMenu() {
  const { user, branches, activeBranch, selectBranch, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // pointerdown: iPad Safari sends no mousedown for most taps, so the menu never closed there.
    const close = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  if (!user) return null;
  const roleText =
    user.role === 'SUPER_ADMIN'
      ? 'Super Admin'
      : activeBranch
        ? `${user.role === 'KITCHEN' ? 'Kitchen · ' : user.role === 'WAITER' ? 'Waiter · ' : ''}${placeName(activeBranch.restaurant.name, activeBranch.name)}`
        : ROLE_LABEL[user.role];
  return (
    <div className="user-menu" ref={ref}>
      <button className="user-button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <span className="avatar">
          <UserRound size={24} />
        </span>
        <span>
          <span className="user-name">{user.name}</span>
          <span className="user-role">
            {roleText}
          </span>
        </span>
        <ChevronDown size={20} />
      </button>
      {open && (
        <div className="menu-popover" role="menu">
          {branches.length > 1 && (
            <>
              <div className="menu-label">Restaurant</div>
              {branches.map((b) => (
                <button
                  key={b.id}
                  className={cx('menu-item', b.id === activeBranch?.id && 'selected')}
                  role="menuitemradio"
                  aria-checked={b.id === activeBranch?.id}
                  onClick={() => {
                    selectBranch(b.id);
                    setOpen(false);
                  }}
                >
                  <Building2 size={18} />
                  <span>{placeName(b.restaurant.name, b.name)}</span>
                  {b.id === activeBranch?.id && <CircleCheck size={18} style={{ marginLeft: 'auto' }} />}
                </button>
              ))}
              <hr className="divider" />
            </>
          )}
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setChangingPassword(true);
              setOpen(false);
            }}
          >
            <KeyRound size={18} /> Change password
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              const done = await logout();
              setSigningOut(false);
              if (!done) return toast.error('Could not sign out – check the internet connection and try again.');
              setOpen(false);
              navigate('/login', { replace: true });
            }}
          >
            <LogOut size={18} /> {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
  );
}

export function AppLayout() {
  const { user, activeBranch } = useAuth();
  const { placeholder, query, setQuery, extra } = useTopbar();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const isKitchen = user?.role === 'KITCHEN';
  const isWaiter = user?.role === 'WAITER';
  // Every dashboard carries the app's name; the restaurant's own name shows with the user (top right).
  const nav = isSuper
    ? ADMIN_NAV
    : isKitchen
      ? [KITCHEN_NAV, SERVED_NAV]
      : isWaiter
        ? [TAKE_ORDER_NAV, WAITER_NAV, SERVED_NAV]
        : activeBranch?.kitchenDisplay
          ? [...RESTAURANT_NAV, KITCHEN_NAV, SERVED_NAV] // Ready to Serve is the waiters' page only
          : RESTAURANT_NAV;
  // Phones: Restaurant Admins get a bottom tab bar, the Super Admin a slide-in menu; a Kitchen
  // login has a single page and needs neither.
  const bottomNav = user?.role === 'RESTAURANT_ADMIN';
  const [navOpen, setNavOpen] = useState(false);
  useRootClass('app-open');
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className={cx('app', bottomNav && 'has-bottom-nav')}>
      <div className="brand">
        <img src="/lemon-tree-icon.png" alt="Lemon Tree" />
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">{APP_NAME}</div>
          <div className="brand-sub">{isSuper ? 'Super Admin Panel' : isKitchen ? 'Kitchen Display' : isWaiter ? 'Waiter' : 'Billing & POS'}</div>
        </div>
      </div>
      <header className="topbar">
        {isSuper && (
          <button className="icon-btn plain nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Open menu" aria-expanded={navOpen}>
            <MenuIcon />
          </button>
        )}
        {/* Phones: Kitchen and Waiter have no sidebar there, so the logo sits in the top bar */}
        {(isKitchen || isWaiter) && <img className="topbar-logo" src="/lemon-tree-icon.png" alt="Lemon Tree" />}
        {placeholder ? (
          <div className="search">
            <Search />
            <input type="search" value={query} placeholder={placeholder} onChange={(e) => setQuery(e.target.value)} aria-label={placeholder} />
            {query && (
              <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search" title="Clear search">
                <X />
              </button>
            )}
          </div>
        ) : (
          <div className="spacer" />
        )}
        {extra && <div className="topbar-extra">{extra}</div>}
        <SyncIndicator />
        <FoodAlerts />
        <UserMenu />
      </header>
      <nav className={cx('sidebar', navOpen && 'open')} aria-label="Main">
        {nav.map(({ to, label, icon: Icon, primary, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('nav-link', primary && 'primary', isActive && 'active')}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
        {user?.role === 'RESTAURANT_ADMIN' && activeBranch && <ShopToggle />}
        <div className="sidebar-footer">© 2026 JAIVA Creative Labs</div>
      </nav>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <main className="content">
        <Suspense fallback={<Loading />}>
          {/* Billing is locked after Close Shop (the server refuses it too). */}
          {activeBranch?.shopOpen === false && /^\/(billing|tables)(\/|$)/.test(location.pathname) ? <ShopClosedNotice /> : <Outlet />}
        </Suspense>
      </main>
      {bottomNav && (
        <nav className="bottom-nav" aria-label="Main">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => cx('bottom-nav-link', isActive && 'active')}>
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
