import {
  bpsToPercent,
  formatBillNumber,
  LIMITS,
  parsePercentToBps,
  type BranchDTO,
  type RestaurantDTO,
  type UserDTO,
} from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, Camera, CirclePlus, FileText, Pencil, Plus, Power, Trash2, Utensils } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActiveBadge } from '../../components/badges';
import { ConfirmButton, ConfirmDialog, Empty, Field, Loading, LogoMark, Modal, PageHeader, SidePanel, Spinner, CancelButton } from '../../components/ui';
import { api, errorMessage } from '../../services/api';
import { useCategories } from '../../services/queries';
import { useToast } from '../../store/toast';
import { cx } from '../../utils/format';
import { shrinkImage } from '../../utils/image';
import { AdminForm, AdminsTable } from './AdminsPage';
import { adminKeys } from './adminShared';
import { RestaurantForm } from './RestaurantsPage';

interface Detail {
  restaurant: RestaurantDTO;
  branches: BranchDTO[];
  admins: UserDTO[];
}

function BranchForm({ restaurant, initial, onClose }: { restaurant: RestaurantDTO; initial?: BranchDTO; onClose: () => void }) {
  const restaurantId = restaurant.id;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    code: initial?.code ?? '',
    address: initial?.address ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
  });
  const code = form.code.trim().toUpperCase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (initial) await api.patch(`/admin/branches/${initial.id}`, form, { branchId: null });
      else await api.post('/admin/branches', { ...form, restaurantId }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(initial ? 'Branch updated' : `Branch “${form.name}” created`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title={initial ? 'Edit Location' : 'Add Location'} onClose={onClose}>
      <form className="stack" style={{ gap: 18 }} onSubmit={submit}>
        <Field label="Location name">{(id) => <input id={id} className="input" value={form.name} onChange={set('name')} maxLength={100} required autoFocus />}</Field>
        <Field
          label="Bill code"
          hint={
            code
              ? `Short code, letters and digits. Bills are numbered ${formatBillNumber(code, 1)}, ${formatBillNumber(code, 2)} …`
              : 'Short code, letters and digits (e.g. ITH). Bills are numbered with it, e.g. ITH0001.'
          }
        >
          {(id) => <input id={id} className="input" value={form.code} onChange={set('code')} maxLength={10} required style={{ textTransform: 'uppercase' }} />}
        </Field>
        <Field label="Address">{(id) => <textarea id={id} className="textarea" value={form.address} onChange={set('address')} maxLength={300} />}</Field>
        <Field label="Phone">{(id) => <input id={id} className="input" value={form.phone} onChange={set('phone')} maxLength={20} />}</Field>
        <Field label="Email">{(id) => <input id={id} className="input" type="email" value={form.email} onChange={set('email')} />}</Field>
        {error && <div className="alert alert-danger">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <Spinner /> : <CirclePlus />} {initial ? 'Save Changes' : 'Create Branch'}
        </button>
      </form>
      {initial?.kitchenDisplay && (
        <>
          <hr className="divider" />
          <KitchenCounters branch={initial} />
        </>
      )}
    </SidePanel>
  );
}

/** The restaurant's logo: shown to its branches and printed on its bills. Tap to change. */
function RestaurantLogo({ restaurant }: { restaurant: RestaurantDTO }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(done);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const form = new FormData();
      form.append('image', await shrinkImage(file));
      await api.upload(`/admin/restaurants/${restaurant.id}/logo`, form, { branchId: null });
    }, 'Logo updated – it shows for the branches and on new bills');
  };
  return (
    <span className="restaurant-logo-edit">
      <label className={cx('restaurant-logo-pick', busy && 'busy')} title="Change logo">
        <LogoMark src={restaurant.logoUrl} name={restaurant.name} />
        <span className="restaurant-logo-cam">{busy ? <Spinner /> : <Camera size={16} />}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      {restaurant.logoUrl && (
        <button
          type="button"
          className="link-btn danger"
          disabled={busy}
          onClick={() => void run(() => api.delete(`/admin/restaurants/${restaurant.id}/logo`, { branchId: null }), 'Logo removed')}
        >
          Remove
        </button>
      )}
    </span>
  );
}

function SettingsTab({ restaurant }: { restaurant: RestaurantDTO }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [taxes, setTaxes] = useState(restaurant.settings.taxes.map((t) => ({ name: t.name, rate: bpsToPercent(t.rateBps) })));
  const [inclusive, setInclusive] = useState(restaurant.settings.pricesIncludeTax);
  const [footer, setFooter] = useState(restaurant.settings.receiptFooter);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const parsed = [];
    for (const t of taxes) {
      const bps = parsePercentToBps(t.rate);
      if (!t.name.trim()) return setError('Every tax needs a name');
      if (bps === null || bps > 10_000) return setError(`Invalid rate for ${t.name}: use a percentage like 2.5`);
      parsed.push({ name: t.name.trim(), rateBps: bps });
    }
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/admin/restaurants/${restaurant.id}/settings`, { taxes: parsed, pricesIncludeTax: inclusive, receiptFooter: footer }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success('Settings saved. New bills use them immediately; existing bills keep their original taxes.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad stack" style={{ maxWidth: 640, gap: 18 }}>
      <div>
        <div className="section-title" style={{ marginBottom: 4 }}>
          Taxes
        </div>
        <span className="field-hint">No tax is applied unless you add one here. Rates are percentages, e.g. CGST 2.5 and SGST 2.5.</span>
      </div>
      {taxes.map((t, i) => (
        <div key={i} className="row">
          <input className="input" placeholder="Name (e.g. CGST)" value={t.name} maxLength={30} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Tax name" />
          <div className="input-prefix" style={{ width: 160 }}>
            <input className="input" inputMode="decimal" placeholder="Rate" value={t.rate} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} aria-label="Tax rate percent" style={{ paddingLeft: 16 }} />
          </div>
          <span className="muted">%</span>
          <button className="icon-btn danger" onClick={() => setTaxes(taxes.filter((_, j) => j !== i))} aria-label="Remove tax">
            <Trash2 />
          </button>
        </div>
      ))}
      {taxes.length < LIMITS.maxTaxes && (
        <button className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTaxes([...taxes, { name: '', rate: '' }])}>
          <Plus size={16} /> Add tax
        </button>
      )}
      <label className="switch">
        <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Menu prices already include tax
      </label>
      <Field label="Receipt footer">{(id) => <input id={id} className="input" value={footer} maxLength={200} onChange={(e) => setFooter(e.target.value)} />}</Field>
      {error && <div className="alert alert-danger">{error}</div>}
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={busy}>
        {busy && <Spinner />} Save settings
      </button>
    </div>
  );
}

/** Turns the branch's Kitchen Display (order tickets board) on or off. */
function KitchenSwitch({ branch }: { branch: BranchDTO }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api.patch(`/admin/branches/${branch.id}`, { kitchenDisplay: on }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(on ? `Kitchen Display on for ${branch.name}` : `Kitchen Display off for ${branch.name}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="switch" title={branch.kitchenDisplay ? 'Orders go to the kitchen board' : 'No kitchen board'}>
      <input type="checkbox" checked={branch.kitchenDisplay} disabled={busy} onChange={(e) => void toggle(e.target.checked)} aria-label={`Kitchen Display for ${branch.name}`} />
      {branch.kitchenDisplay ? 'On' : 'Off'}
    </label>
  );
}

/**
 * Kitchen counters (Tiffin, Juice…): each gets the dishes of its categories as its own ticket, and
 * a Kitchen login can be given one counter. Categories no counter lists go to the first.
 */
function KitchenCounters({ branch }: { branch: BranchDTO }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const categories = useCategories({ branchId: branch.id });
  const [list, setList] = useState(branch.kitchenStations.map((s) => ({ ...s, key: s.id })));
  const [busy, setBusy] = useState(false);
  const counterOf = new Map(list.flatMap((s) => s.categoryIds.map((c) => [c, s.key] as const)));
  const update = (key: string, patch: Partial<(typeof list)[number]>) => setList((l) => l.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  // A category belongs to one counter: picking it here takes it from the other.
  const toggle = (key: string, categoryId: string) =>
    setList((l) =>
      l.map((s) =>
        s.key === key
          ? { ...s, categoryIds: s.categoryIds.includes(categoryId) ? s.categoryIds.filter((c) => c !== categoryId) : [...s.categoryIds, categoryId] }
          : { ...s, categoryIds: s.categoryIds.filter((c) => c !== categoryId) },
      ),
    );

  const save = async () => {
    setBusy(true);
    try {
      const stations = list.map((s) => ({ ...(s.id && { id: s.id }), name: s.name.trim(), categoryIds: s.categoryIds }));
      const saved = await api.put<BranchDTO>(`/admin/branches/${branch.id}/kitchen-stations`, { stations }, { branchId: null });
      setList(saved.kitchenStations.map((s) => ({ ...s, key: s.id })));
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(saved.kitchenStations.length ? 'Kitchen counters saved' : 'One kitchen for every order');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <span className="field-label">Kitchen counters</span>
      <span className="field-hint" style={{ marginTop: 0 }}>
        For a kitchen with separate counters (Tiffin, Juice…): each counter gets its own ticket and can have its own Kitchen login. Categories not picked go to the
        first counter. Leave empty for one kitchen.
      </span>
      <div className="stack" style={{ gap: 10, marginTop: 6 }}>
        {list.map((s, i) => (
          <div key={s.key} className="kitchen-counter">
            <div className="row" style={{ gap: 8 }}>
              <input className="input input-sm" value={s.name} onChange={(e) => update(s.key, { name: e.target.value })} maxLength={40} placeholder={i === 0 ? 'e.g. Tiffin' : 'e.g. Juice'} aria-label="Counter name" />
              <button type="button" className="icon-btn plain danger-text" onClick={() => setList((l) => l.filter((x) => x.key !== s.key))} title="Remove counter" aria-label={`Remove ${s.name || 'counter'}`}>
                <Trash2 />
              </button>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(categories.data ?? []).map((c) => {
                const on = counterOf.get(c.id) === s.key;
                const elsewhere = !on && counterOf.has(c.id);
                return (
                  <button key={c.id} type="button" className={cx('chip chip-sm', on && 'active', elsewhere && 'muted')} aria-pressed={on} onClick={() => toggle(s.key, c.id)}>
                    {c.icon} {c.name}
                  </button>
                );
              })}
            </div>
            {i === 0 && <span className="field-hint">Also gets every category not picked for another counter.</span>}
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            disabled={list.length >= LIMITS.maxKitchenStations}
            onClick={() => setList((l) => [...l, { id: '', key: `new-${Date.now()}`, name: '', categoryIds: [] }])}
          >
            <Plus /> Add counter
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || list.some((s) => !s.name.trim())}>
            {busy && <Spinner />} Save counters
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deleting is for good, so the restaurant's name has to be typed first. */
/** A restaurant run as one branch (all new ones): its bill code and Kitchen Display, with no branch wording. */
function BillsAndKitchen({ branch }: { branch: BranchDTO }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState(branch.code);
  const [busy, setBusy] = useState(false);
  const clean = code.trim().toUpperCase();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/admin/branches/${branch.id}`, { code: clean }, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success('Bill code saved');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad stack" style={{ gap: 22, maxWidth: 560 }}>
      <form className="field" onSubmit={save}>
        <label className="field-label" htmlFor="bill-code">
          Bill code
        </label>
        <div className="row" style={{ gap: 8 }}>
          <input id="bill-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} required style={{ textTransform: 'uppercase', maxWidth: 160 }} />
          <button className="btn btn-primary" disabled={busy || !clean || clean === branch.code}>
            {busy ? <Spinner /> : null} Save
          </button>
        </div>
        <span className="field-hint">
          Bills are numbered {formatBillNumber(clean || branch.code, 1)}, {formatBillNumber(clean || branch.code, 2)} … A new code starts again at 0001.
        </span>
      </form>
      <div className="field">
        <span className="field-label">Kitchen Display</span>
        <KitchenSwitch branch={branch} />
        <span className="field-hint">Orders go to the Kitchen screen, and food the kitchen marks Ready to the Waiter screen.</span>
      </div>
      {branch.kitchenDisplay && <KitchenCounters key={branch.kitchenStations.map((s) => s.id).join()} branch={branch} />}
    </div>
  );
}

function DeleteRestaurantDialog({ restaurant, branchCount, onClose }: { restaurant: RestaurantDTO; branchCount: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === restaurant.name.trim().toLowerCase();

  const remove = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await api.delete(`/admin/restaurants/${restaurant.id}`, { branchId: null });
      navigate('/admin/restaurants', { replace: true });
      queryClient.removeQueries({ queryKey: adminKeys.restaurant(restaurant.id) });
      await queryClient.invalidateQueries();
      toast.success(`“${restaurant.name}” deleted`);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${restaurant.name}?`} onClose={busy ? () => undefined : onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="alert alert-danger">
          <Trash2 />
          <span>
            This deletes the restaurant for good{branchCount > 1 ? `, with its ${branchCount} locations` : ''}, with its menu, tables, all bills and
            expenses, and its Restaurant Admin logins. It cannot be undone. To keep the records, use Deactivate instead.
          </span>
        </div>
        <Field label={<>Type <strong>{restaurant.name}</strong> to confirm</>}>
          {(id) => (
            <input
              id={id}
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void remove()}
              autoComplete="off"
              autoFocus
            />
          )}
        </Field>
        <div className="modal-actions">
          <CancelButton onClick={onClose} disabled={busy} label="No" />
          <ConfirmButton onClick={() => void remove()} busy={busy} disabled={!matches} label="Delete for good" />
        </div>
      </div>
    </Modal>
  );
}

/** Deletes one location of a restaurant that has several (type its name to confirm). */
function DeleteLocationDialog({ branch, onClose }: { branch: BranchDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === branch.name.trim().toLowerCase();

  const remove = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await api.delete(`/admin/branches/${branch.id}`, { branchId: null });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(`“${branch.name}” deleted`);
      onClose();
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${branch.name}?`} onClose={busy ? () => undefined : onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="alert alert-danger">
          <Trash2 />
          <span>
            This deletes this location for good, with its tables, all its bills and expenses, and the logins that work only there. The
            restaurant and its other locations stay. It cannot be undone.
          </span>
        </div>
        <Field label={<>Type <strong>{branch.name}</strong> to confirm</>}>
          {(id) => (
            <input
              id={id}
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void remove()}
              autoComplete="off"
              autoFocus
            />
          )}
        </Field>
        <div className="modal-actions">
          <CancelButton onClick={onClose} disabled={busy} label="No" />
          <ConfirmButton onClick={() => void remove()} busy={busy} disabled={!matches} label="Delete for good" />
        </div>
      </div>
    </Modal>
  );
}

export function RestaurantDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'branches' | 'admins' | 'settings'>('branches');
  const [panel, setPanel] = useState<{ kind: 'branch'; branch?: BranchDTO } | { kind: 'admin' } | { kind: 'edit' } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'restaurant' } | { kind: 'branch'; branch: BranchDTO } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState<BranchDTO | null>(null);
  const detail = useQuery({ queryKey: adminKeys.restaurant(id!), queryFn: () => api.get<Detail>(`/admin/restaurants/${id}`, { branchId: null }) });

  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <Empty title="Restaurant not found">{errorMessage(detail.error)}</Empty>;
  const { restaurant, branches, admins } = detail.data!;

  const toggleStatus = async () => {
    try {
      if (confirm?.kind === 'restaurant') {
        await api.patch(`/admin/restaurants/${restaurant.id}/status`, { status: restaurant.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }, { branchId: null });
      } else if (confirm?.kind === 'branch') {
        await api.patch(`/admin/branches/${confirm.branch.id}/status`, { status: confirm.branch.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }, { branchId: null });
      }
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success('Status updated');
    } catch (err) {
      toast.error(err);
    } finally {
      setConfirm(null);
    }
  };

  return (
    <>
      <div className="page">
        <Link to="/admin/restaurants" className="link-btn" style={{ marginBottom: 12 }}>
          <ArrowLeft size={16} /> All restaurants
        </Link>
        <PageHeader
          title={
            <span className="row">
              <RestaurantLogo restaurant={restaurant} />
              {restaurant.name} <ActiveBadge status={restaurant.status} />
            </span>
          }
          subtitle={restaurant.address || 'No address yet'}
          actions={
            <>
              <button className="btn btn-outline" onClick={() => setPanel({ kind: 'edit' })}>
                <Pencil /> Edit
              </button>
              <button className="btn btn-outline" onClick={() => setConfirm({ kind: 'restaurant' })}>
                <Power /> {restaurant.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
              </button>
              <button className="btn btn-danger-soft" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </button>
              <button className="btn btn-soft" onClick={() => navigate(`/admin/transactions?restaurantId=${restaurant.id}`)}>
                <FileText /> Transactions
              </button>
              <button className="btn btn-primary" onClick={() => navigate(`/admin/menu?restaurantId=${restaurant.id}`)}>
                <Utensils /> Menu Management
              </button>
            </>
          }
        />
        <div className="tabs" role="tablist">
          {(
            [
              ['branches', branches.length > 1 ? `Locations (${branches.length})` : 'Bills & Kitchen'],
              ['admins', `Employees (${admins.length})`],
              ['settings', 'Taxes & Receipt'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={cx('tab', tab === key && 'active')} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'branches' && branches.length === 1 && <BillsAndKitchen key={branches[0].id} branch={branches[0]} />}
        {/* Older restaurants with several locations keep their list (no new ones are added). */}
        {tab === 'branches' && branches.length !== 1 && (
          <div className="card">
            <div className="row card-pad" style={{ paddingBottom: 0 }}>
              <span className="card-title">Locations</span>
            </div>
            {branches.length === 0 ? (
              <Empty icon={<Building2 />} title="Nothing set up yet">
                This restaurant has no location for its bills.
              </Empty>
            ) : (
              <div className="data-table-wrap" style={{ marginTop: 14 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Bill code</th>
                      <th>Contact</th>
                      <th>Status</th>
                      <th>Kitchen Display</th>
                      <th className="right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branches.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <strong>{b.name}</strong>
                          <span className="cell-sub">{b.address}</span>
                        </td>
                        <td data-label="Code">
                          {b.code}
                          <span className="cell-sub">Bills {formatBillNumber(b.code, 1)}…</span>
                        </td>
                        <td data-label="Contact" className="muted">{[b.phone, b.email].filter(Boolean).join(' · ') || '—'}</td>
                        <td data-label="Status">
                          <ActiveBadge status={b.status} />
                        </td>
                        <td data-label="Kitchen Display">
                          <KitchenSwitch branch={b} />
                        </td>
                        <td className="right nowrap">
                          <button className="icon-btn plain" onClick={() => navigate(`/admin/menu?restaurantId=${restaurant.id}&branchId=${b.id}`)} title="Location menu" aria-label={`Menu of ${b.name}`}>
                            <Utensils />
                          </button>
                          <button className="icon-btn plain" onClick={() => setPanel({ kind: 'branch', branch: b })} title="Edit" aria-label={`Edit ${b.name}`}>
                            <Pencil />
                          </button>
                          <button className="icon-btn plain" onClick={() => setConfirm({ kind: 'branch', branch: b })} title={b.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} aria-label={`Toggle ${b.name}`}>
                            <Power />
                          </button>
                          <button className="icon-btn plain danger-text" onClick={() => setDeletingBranch(b)} title="Delete" aria-label={`Delete ${b.name}`}>
                            <Trash2 />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'admins' && (
          <div className="card">
            <div className="row card-pad" style={{ paddingBottom: 14 }}>
              <span className="card-title">Employees</span>
              <span className="spacer" />
              <button className="btn btn-primary btn-sm" onClick={() => setPanel({ kind: 'admin' })} disabled={branches.length === 0}>
                <CirclePlus size={16} /> Add Employee
              </button>
            </div>
            <AdminsTable users={admins} branches={branches} />
          </div>
        )}

        {tab === 'settings' && <SettingsTab key={restaurant.id} restaurant={restaurant} />}
      </div>

      {panel?.kind === 'branch' && <BranchForm restaurant={restaurant} initial={panel.branch} onClose={() => setPanel(null)} />}
      {panel?.kind === 'admin' && <AdminForm restrictTo={restaurant.id} onClose={() => setPanel(null)} />}
      {panel?.kind === 'edit' && (
        <RestaurantForm
          initial={restaurant}
          onClose={() => setPanel(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin'] });
            setPanel(null);
          }}
        />
      )}
      {deletingBranch && <DeleteLocationDialog branch={deletingBranch} onClose={() => setDeletingBranch(null)} />}
      {deleting && <DeleteRestaurantDialog restaurant={restaurant} branchCount={branches.length} onClose={() => setDeleting(false)} />}
      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'restaurant'
              ? `${restaurant.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${restaurant.name}?`
              : `${confirm.branch.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${confirm.branch.name}?`
          }
          message={
            (confirm.kind === 'restaurant' ? restaurant.status : confirm.branch.status) === 'ACTIVE'
              ? 'Restaurant Admins lose access to it immediately. Records and transactions are kept.'
              : 'Assigned Restaurant Admins regain access.'
          }
          confirmLabel="Confirm"
          danger={(confirm.kind === 'restaurant' ? restaurant.status : confirm.branch.status) === 'ACTIVE'}
          onCancel={() => setConfirm(null)}
          onConfirm={toggleStatus}
        />
      )}
    </>
  );
}
