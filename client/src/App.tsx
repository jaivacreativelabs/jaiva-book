import type { Role } from '@rb/shared';
import { Building2 } from 'lucide-react';
import { lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Empty, Spinner } from './components/ui';
import { AppLayout } from './layouts/AppLayout';
import { LoginPage } from './pages/auth/LoginPage';
import { BillingPage } from './pages/restaurant/BillingPage';
import { ExpensesPage } from './pages/restaurant/ExpensesPage';
import { MenuPage } from './pages/restaurant/MenuPage';
import { PrintReceiptPage } from './pages/restaurant/PrintReceiptPage';
import { KitchenPage, PrintKitchenTicketPage } from './pages/restaurant/KitchenPage';
import { WaiterPage } from './pages/restaurant/WaiterPage';
import { WaiterOrderPage } from './pages/restaurant/WaiterOrderPage';
import { TablesPage } from './pages/restaurant/TablesPage';
import { TransactionsPage } from './pages/restaurant/TransactionsPage';
import { useAuth } from './store/auth';
import { homeFor } from './utils/roles';

// Super Admin pages are only downloaded by Super Admins.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const RestaurantsPage = named(() => import('./pages/admin/RestaurantsPage'), 'RestaurantsPage');
const RestaurantDetailPage = named(() => import('./pages/admin/RestaurantDetailPage'), 'RestaurantDetailPage');
const AdminsPage = named(() => import('./pages/admin/AdminsPage'), 'AdminsPage');
const AdminMenuPage = named(() => import('./pages/admin/AdminMenuPage'), 'AdminMenuPage');
const AdminTransactionsPage = named(() => import('./pages/admin/AdminTransactionsPage'), 'AdminTransactionsPage');
const AdminExpensesPage = named(() => import('./pages/admin/AdminExpensesPage'), 'AdminExpensesPage');
const ReportsPage = named(() => import('./pages/admin/ReportsPage'), 'ReportsPage');
const AnalyticsPage = named(() => import('./pages/admin/AnalyticsPage'), 'AnalyticsPage');
const AuditLogPage = named(() => import('./pages/admin/AuditLogPage'), 'AuditLogPage');
const DemoLoginsPage = named(() => import('./pages/admin/DemoLoginsPage'), 'DemoLoginsPage');
const DailyReportPage = named(() => import('./pages/admin/DailyReportPage'), 'DailyReportPage');

function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading, activeBranch } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  if (user.role !== 'SUPER_ADMIN' && !activeBranch) {
    return (
      <div className="center-screen">
        <Empty icon={<Building2 />} title="No active restaurant assigned">
          Your account is not assigned to an active restaurant. Please contact your Super Admin.
        </Empty>
      </div>
    );
  }
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/print/transactions/:id" element={<PrintReceiptPage />} />
      <Route path="/print/kitchen/:id" element={<PrintKitchenTicketPage />} />
      <Route
        element={
          <RequireRole roles={['RESTAURANT_ADMIN']}>
            <AppLayout />
          </RequireRole>
        }
      >
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/menu" element={<MenuPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/tables" element={<TablesPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
      </Route>
      <Route
        element={
          <RequireRole roles={['RESTAURANT_ADMIN', 'KITCHEN']}>
            <AppLayout />
          </RequireRole>
        }
      >
        <Route path="/kitchen" element={<KitchenPage />} />
      </Route>
      <Route
        element={
          <RequireRole roles={['RESTAURANT_ADMIN', 'WAITER']}>
            <AppLayout />
          </RequireRole>
        }
      >
        <Route path="/waiter" element={<WaiterPage />} />
      </Route>
      <Route
        element={
          <RequireRole roles={['WAITER']}>
            <AppLayout />
          </RequireRole>
        }
      >
        <Route path="/waiter/order" element={<WaiterOrderPage />} />
      </Route>
      <Route
        path="/admin"
        element={
          <RequireRole roles={['SUPER_ADMIN']}>
            <AppLayout />
          </RequireRole>
        }
      >
        <Route index element={<Navigate to="restaurants" replace />} />
        <Route path="restaurants" element={<RestaurantsPage />} />
        <Route path="restaurants/:id" element={<RestaurantDetailPage />} />
        <Route path="users" element={<AdminsPage />} />
        <Route path="menu" element={<AdminMenuPage />} />
        <Route path="transactions" element={<AdminTransactionsPage />} />
        <Route path="expenses" element={<AdminExpensesPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="daily-report" element={<DailyReportPage />} />
        <Route path="demo-logins" element={<DemoLoginsPage />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
