import { passwordSchema, placeName, type BranchDTO, type StaffRole, type UserDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, CirclePlus, ConciergeBell, KeyRound, LayoutGrid, Pencil, Power, Store, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ActiveBadge } from '../../components/badges';
import { CancelButton, ConfirmButton, ConfirmDialog, Empty, Field, Loading, Modal, PageHeader, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../services/api';
import { useToast } from '../../store/toast';
import { usePageSearch } from '../../store/topbar';
import { cx, formatDateTime } from '../../utils/format';
import { adminKeys, useAllBranches, useRestaurants } from './adminShared';

/**
 * Branch picker grouped by restaurant. Branches are fully isolated, so a Restaurant Admin
 * manages exactly one branch (radio buttons).
 */
function BranchAssignment({ value, onChange, restrictTo }: { value: string | null; onChange: (id: string) => void; restrictTo?: string }) {
  const restaurants = useRestaurants();
  const branches = useAllBranches();
  const groups = (restaurants.data ?? [])
    .filter((r) => !restrictTo || r.id === restrictTo)
    .map((r) => ({ restaurant: r, branches: (branches.data ?? []).filter((b) => b.restaurantId === r.id) }))
    .filter((g) => g.branches.length > 0);
  if (groups.length === 0) return <span className="field-hint">Create a restaurant first.</span>;
  return (
    <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Restaurant">
      {groups.flatMap(({ restaurant, branches: list }) =>
        list.map((b) => (
          <label key={b.id} className="check">
            <input type="radio" name="admin-branch" checked={value === b.id} onChange={() => onChange(b.id)} />
            {placeName(restaurant.name, b.name)}
            {(restaurant.status === 'INACTIVE' || b.status === 'INACTIVE') && <span className="badge badge-gray badge-sm">inactive</span>}
          </label>
        )),
      )}
    </div>
  );
}

export function AdminForm({ initial, restrictTo, onClose }: { initial?: UserDTO; restrictTo?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [password, setPassword] = useState('');
  // Older accounts may still list several branches; editing keeps only one.
  const [branchId, setBranchId] = useState<string | null>(initial?.branchIds[0] ?? null);
  const [role, setRole] = useState<StaffRole>(initial?.role === 'KITCHEN' || initial?.role === 'WAITER' ? initial.role : 'RESTAURANT_ADMIN');
  const kind = role === 'KITCHEN' ? 'Kitchen login' : role === 'WAITER' ? 'Waiter login' : 'Restaurant Admin';
  // Kitchen logins of a restaurant with kitchen counters can work one counter ('' → every counter).
  const [stationId, setStationId] = useState(initial?.kitchenStationId ?? '');
  const stations = (useAllBranches().data ?? []).find((b) => b.id === branchId)?.kitchenStations ?? [];
  const kitchenStationId = role === 'KITCHEN' && stations.some((s) => s.id === stationId) ? stationId : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!initial) {
      const check = passwordSchema.safeParse(password);
      if (!check.success) return setError(`Password: ${check.error.issues[0].message}`);
    }
    if (!branchId)
      return setError(
        role === 'KITCHEN' ? 'Choose the restaurant whose kitchen this login shows' : role === 'WAITER' ? 'Choose the restaurant this waiter works in' : 'Choose the restaurant this admin manages',
      );
    const branchIds = [branchId];
    setBusy(true);
    setError(null);
    try {
      if (initial) await api.patch(`/admin/users/${initial.id}`, { name, branchIds, ...(role === 'KITCHEN' && { kitchenStationId }) }, { branchId: null });
      else await api.post('/admin/users', { name, email, password, branchIds, role, kitchenStationId }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(initial ? `${kind} updated` : `${kind} ${email} created`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${kind}` : 'Add Employee'} onClose={onClose} width={560}>
      <form className="stack" style={{ gap: 18 }} onSubmit={submit}>
        <p className="muted" style={{ margin: '-8px 0 0' }}>
          {role === 'KITCHEN'
            ? 'A Kitchen login only sees the Kitchen Display of one restaurant – no bills, sales or prices'
            : role === 'WAITER'
              ? 'A Waiter login (one per waiter) only sees food the kitchen marked Ready in one restaurant, and marks it Served'
              : 'A Restaurant Admin runs one restaurant – its billing, tables, menu and transactions'}
        </p>
        {!initial && (
          <div className="field">
            <span className="field-label">Role</span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Role">
              {(
                [
                  ['RESTAURANT_ADMIN', 'Admin', Store],
                  ['KITCHEN', 'Kitchen', ChefHat],
                  ['WAITER', 'Waiter', ConciergeBell],
                ] as const
              ).map(([value, label, Icon]) => (
                <button key={value} type="button" role="radio" aria-checked={role === value} className={cx('chip outline', role === value && 'active')} onClick={() => setRole(value)}>
                  <Icon size={16} /> {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Full name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />}</Field>
        <Field label="Email (login)">
          {(id) => <input id={id} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(initial)} required />}
        </Field>
        {!initial && (
          <Field label="Temporary password" hint="At least 8 characters with a letter and a number. Ask the admin to change it after signing in.">
            {(id) => <input id={id} className="input" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
          </Field>
        )}
        <div className="field">
          <span className="field-label">Restaurant</span>
          <BranchAssignment value={branchId} onChange={setBranchId} restrictTo={initial ? undefined : restrictTo} />
          {initial && initial.branchIds.length > 1 && (
            <span className="field-hint">This admin had several restaurants. Saving keeps only the selected one.</span>
          )}
        </div>
        {role === 'KITCHEN' && stations.length > 0 && (
          <div className="field">
            <span className="field-label">Kitchen counter</span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Kitchen counter">
              {[{ id: '', name: 'All counters' }, ...stations].map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={(kitchenStationId ?? '') === s.id} className={cx('chip outline', (kitchenStationId ?? '') === s.id && 'active')} onClick={() => setStationId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
            <span className="field-hint">A counter&apos;s login only sees the orders for that counter (Juice, Tiffin…).</span>
          </div>
        )}
        {error && <div className="alert alert-danger">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <Spinner /> : <CirclePlus />} {initial ? 'Save Changes' : role === 'KITCHEN' ? 'Create Kitchen Login' : role === 'WAITER' ? 'Create Waiter Login' : 'Create Admin'}
        </button>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: UserDTO; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const check = passwordSchema.safeParse(password);
    if (!check.success) return setError(check.error.issues[0].message);
    setBusy(true);
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { password }, { branchId: null });
      toast.success(`Password reset for ${user.email}. Existing sessions were signed out.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Reset password – ${user.name}`} onClose={onClose}>
      <Field label="New temporary password" error={error}>
        {(id) => <input id={id} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <div className="modal-actions">
        <CancelButton onClick={onClose} disabled={busy} />
        <ConfirmButton onClick={submit} busy={busy} label="Reset password" />
      </div>
    </Modal>
  );
}

/** The employee list's sections, in this order. */
const EMPLOYEE_GROUPS: { key: UserDTO['role']; label: string; Icon: typeof Store }[] = [
  { key: 'RESTAURANT_ADMIN', label: 'Admins', Icon: Store },
  { key: 'KITCHEN', label: 'Kitchen', Icon: ChefHat },
  { key: 'WAITER', label: 'Waiters', Icon: ConciergeBell },
];

export function AdminsTable({ users, branches }: { users: UserDTO[]; branches: BranchDTO[] }) {
  const restaurantName = new Map((useRestaurants().data ?? []).map((r) => [r.id, r.name]));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<UserDTO | null>(null);
  const [resetting, setResetting] = useState<UserDTO | null>(null);
  const [toggling, setToggling] = useState<UserDTO | null>(null);
  const [deleting, setDeleting] = useState<UserDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const branchName = new Map(branches.map((b) => [b.id, b]));
  const counterName = (u: UserDTO) =>
    u.kitchenStationId ? (branchName.get(u.branchIds[0])?.kitchenStations.find((s) => s.id === u.kitchenStationId)?.name ?? '') : '';
  // Kitchen logins are listed by counter; a login for every counter comes first.
  const groups = EMPLOYEE_GROUPS.map((g) => ({
    ...g,
    users: users.filter((u) => u.role === g.key).sort((a, b) => (g.key === 'KITCHEN' ? counterName(a).localeCompare(counterName(b)) : 0)),
  })).filter((g) => g.users.length > 0);

  const toggle = async (u: UserDTO) => {
    try {
      await api.patch(`/admin/users/${u.id}/status`, { status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(u.status === 'ACTIVE' ? `${u.name} deactivated and signed out` : `${u.name} activated`);
    } catch (err) {
      toast.error(err);
    } finally {
      setToggling(null);
    }
  };

  const remove = async (u: UserDTO) => {
    setBusy(true);
    try {
      await api.delete(`/admin/users/${u.id}`, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(`${u.name} deleted`);
      setDeleting(null);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  if (users.length === 0) return <Empty icon={<Users />} title="No employees yet" />;
  return (
    <>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Restaurant</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              <tr className="table-group-head">
                <td colSpan={5}>
                  <g.Icon size={16} /> {g.label} <span className="badge badge-gray badge-sm">{g.users.length}</span>
                </td>
              </tr>
              {g.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    {counterName(u) && (
                      <span className="badge badge-amber badge-sm" style={{ marginLeft: 6 }}>
                        {counterName(u)} counter
                      </span>
                    )}
                    <span className="cell-sub">{u.email}</span>
                  </td>
                  <td data-label="Restaurant">
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {u.branchIds.map((id) => {
                        const b = branchName.get(id);
                        return (
                          <span key={id} className="badge badge-primary badge-sm">
                            {b ? placeName(restaurantName.get(b.restaurantId) ?? '', b.name) : 'Unknown'}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td data-label="Status">
                    <ActiveBadge status={u.status} />
                  </td>
                  <td data-label="Last sign-in" className="muted nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                  <td className="right nowrap">
                    <button className="icon-btn plain" onClick={() => setEditing(u)} title="Edit / reassign" aria-label={`Edit ${u.name}`}>
                      <Pencil />
                    </button>
                    <button className="icon-btn plain" onClick={() => setResetting(u)} title="Reset password" aria-label={`Reset password of ${u.name}`}>
                      <KeyRound />
                    </button>
                    <button className="icon-btn plain" onClick={() => setToggling(u)} title={u.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} aria-label={`Toggle ${u.name}`}>
                      <Power />
                    </button>
                    <button className="icon-btn plain danger-text" onClick={() => setDeleting(u)} title="Delete" aria-label={`Delete ${u.name}`}>
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {editing && <AdminForm initial={editing} onClose={() => setEditing(null)} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
      {toggling && (
        <ConfirmDialog
          title={toggling.status === 'ACTIVE' ? `Deactivate ${toggling.name}?` : `Activate ${toggling.name}?`}
          message={toggling.status === 'ACTIVE' ? 'They will be signed out immediately and cannot sign in until reactivated.' : 'They will be able to sign in again.'}
          confirmLabel={toggling.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
          danger={toggling.status === 'ACTIVE'}
          onCancel={() => setToggling(null)}
          onConfirm={() => toggle(toggling)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message={`${deleting.email} is deleted for good and signed out at once. Bills and orders they made stay, with their name on them. To only block the login for now, use Deactivate instead.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => !busy && setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </>
  );
}

/** The filter bubbles above the employee list: the Restaurant Admin is the one at the cash counter. */
const ROLE_FILTERS: { key: 'ALL' | UserDTO['role']; label: string; Icon: typeof Store }[] = [
  { key: 'ALL', label: 'All', Icon: LayoutGrid },
  { key: 'RESTAURANT_ADMIN', label: 'Cashier', Icon: Store },
  { key: 'KITCHEN', label: 'Kitchen', Icon: ChefHat },
  { key: 'WAITER', label: 'Waiter', Icon: ConciergeBell },
];

export function AdminsPage() {
  const search = usePageSearch('Search employees by name or email...');
  const users = useQuery({ queryKey: adminKeys.users, queryFn: () => api.get<UserDTO[]>('/admin/users', { branchId: null }) });
  const branches = useAllBranches();
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<(typeof ROLE_FILTERS)[number]['key']>('ALL');
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
  }, [users.data, search]);
  const visible = role === 'ALL' ? matching : matching.filter((u) => u.role === role);
  const filter = ROLE_FILTERS.find((f) => f.key === role) ?? ROLE_FILTERS[0];

  return (
    <>
      <div className="page">
        <PageHeader
          title="Employees"
          actions={
            <button className="btn btn-primary btn-lg" onClick={() => setAdding(true)}>
              <CirclePlus /> Add Employee
            </button>
          }
        />
        <div className="chips" role="radiogroup" aria-label="Show employees" style={{ marginBottom: 16 }}>
          {ROLE_FILTERS.map(({ key, label, Icon }) => (
            <button key={key} type="button" role="radio" aria-checked={role === key} className={cx('chip', role === key && 'active')} onClick={() => setRole(key)}>
              <Icon /> {label}
              <span className="badge badge-gray badge-sm">{key === 'ALL' ? matching.length : matching.filter((u) => u.role === key).length}</span>
            </button>
          ))}
        </div>
        <div className="card">
          {users.isLoading ? (
            <Loading />
          ) : role !== 'ALL' && visible.length === 0 && (users.data?.length ?? 0) > 0 ? (
            <Empty icon={<filter.Icon />} title={`No ${filter.label.toLowerCase()} logins${search.trim() ? ' match the search' : ' yet'}`} />
          ) : (
            <AdminsTable users={visible} branches={branches.data ?? []} />
          )}
        </div>
      </div>
      {adding && <AdminForm onClose={() => setAdding(false)} />}
    </>
  );
}
