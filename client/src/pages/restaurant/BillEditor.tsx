import { BILL_EDIT_WINDOW_MINUTES, calculateBill, placeName, type PaymentPart, type RestaurantDTO, type TaxSettings, type TransactionDTO } from '@rb/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronUp, Clock, Minus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { FoodGrid, addItemToBill, setBillQuantity } from '../../components/FoodGrid';
import { FoodImage } from '../../components/FoodImage';
import { useRootClass } from '../../hooks/useRootClass';
import { PaymentButtons, paymentFields, SplitPayment, type PaymentChoice } from '../../components/PaymentButtons';
import { CancelButton, ConfirmButton, Field, SidePanel } from '../../components/ui';
import { ApiError, api } from '../../services/api';
import { useAuth } from '../../store/auth';
import type { LocalBill } from '../../store/draftSync';
import { useToast } from '../../store/toast';
import { adminKeys } from '../admin/adminShared';
import { formatDateTime, formatMoney } from '../../utils/format';
import { splitVariant } from '../../utils/menu';

/** Minutes left to edit a bill (rounded up), ticking while the screen is open; 0 once closed. */
export function useEditMinutesLeft(editableUntil: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!editableUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [editableUntil]);
  if (!editableUntil) return 0;
  return Math.max(0, Math.ceil((new Date(editableUntil).getTime() - now) / 60_000));
}

function toLocalBill(tx: TransactionDTO): LocalBill {
  return {
    items: tx.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, imageUrl: i.imageUrl, unitPrice: i.unitPrice, taxable: i.taxable, taxRateBps: i.taxRateBps, extraTaxes: i.extraTaxes, quantity: i.quantity, unavailable: false, note: '' })),
    customerName: tx.customerName,
    discount: tx.discount ? { type: tx.discount.type as 'PERCENT' | 'FLAT', value: tx.discount.value } : null,
  };
}

/**
 * Correcting a paid bill within BILL_EDIT_WINDOW_MINUTES: the branch menu on the left, the bill
 * on the right (same layout as ordering for a table). The server re-prices and keeps the old version.
 */
export function BillEditor({ tx, search, onCancel, onSaved }: { tx: TransactionDTO; search: string; onCancel: () => void; onSaved: (t: TransactionDTO) => void }) {
  const toast = useToast();
  const { activeBranch, user } = useAuth();
  // Restaurant Admins have BILL_EDIT_WINDOW_MINUTES; the Super Admin can correct a bill any time.
  const anyTime = user?.role === 'SUPER_ADMIN';
  const [bill, setBill] = useState(() => toLocalBill(tx));
  const wasSplit = tx.payments.length > 1;
  const [payment, setPayment] = useState<PaymentChoice>(wasSplit ? 'SPLIT' : tx.paymentMethod);
  const [splitParts, setSplitParts] = useState<PaymentPart[] | null>(wasSplit ? tx.payments : null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [panelOnPhone, setPanelOnPhone] = useState(false);
  useRootClass('has-bill-bar');
  const minutesLeft = useEditMinutesLeft(anyTime ? null : tx.editableUntil);
  const canEdit = anyTime || minutesLeft > 0;

  // The preview uses the restaurant's tax settings; the server's totals are the ones saved. A
  // bill's tax lines cannot stand in for them, since items may carry their own GST.
  const inBranch = activeBranch?.id === tx.branchId;
  const restaurants = useQuery({
    queryKey: adminKeys.restaurants,
    queryFn: () => api.get<RestaurantDTO[]>('/admin/restaurants', { branchId: null }),
    enabled: !inBranch && anyTime,
  });
  const settings: TaxSettings = useMemo(
    () =>
      inBranch
        ? activeBranch!.restaurant.settings
        : (restaurants.data?.find((r) => r.id === tx.restaurantId)?.settings ?? { taxes: [], pricesIncludeTax: tx.pricesIncludeTax }),
    [inBranch, activeBranch, restaurants.data, tx],
  );
  const totals = useMemo(() => calculateBill(bill.items, settings, bill.discount), [bill, settings]);
  const qtyById = useMemo(() => new Map(bill.items.map((i) => [i.menuItemId, i.quantity])), [bill.items]);
  const count = bill.items.reduce((a, i) => a + i.quantity, 0);
  const paid = payment !== 'SPLIT' || splitParts ? paymentFields(payment, splitParts) : null;
  const changed =
    JSON.stringify(paid?.payments ?? [{ method: paid?.paymentMethod, amount: totals.grandTotal }]) !== JSON.stringify(tx.payments) ||
    bill.items.length !== tx.items.length ||
    bill.items.some((l, i) => l.menuItemId !== tx.items[i].menuItemId || l.quantity !== tx.items[i].quantity);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.put<TransactionDTO>(
        `/transactions/${tx.id}`,
        {
          editCount: tx.editCount,
          items: bill.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
          ...paid!,
          ...(reason.trim() && { reason: reason.trim() }),
        },
        { branchId: null },
      );
      toast.success(`Bill #${saved.billNumber} updated`);
      onSaved(saved);
    } catch (err) {
      toast.error(err);
      if (err instanceof ApiError && (err.code === 'CONFLICT' || err.code === 'EDIT_WINDOW_CLOSED' || err.code === 'INVALID_STATUS')) {
        const current = (err.details as { current?: TransactionDTO } | undefined)?.current;
        onSaved(current ?? tx);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page">
        <div className="ordering-head">
          <button className="link-btn" onClick={onCancel}>
            <ArrowLeft size={16} /> Transactions
          </button>
          <h1 className="page-title">Edit bill #{tx.billNumber}</h1>
        </div>
        <FoodGrid branchId={tx.branchId} search={search} qtyById={qtyById} editable={canEdit} onAdd={(item) => setBill((b) => addItemToBill(b, item))} />
      </div>

      <button type="button" className="bill-mobile-bar" onClick={() => setPanelOnPhone(true)} aria-label="View bill">
        <span className="count">
          {count} item{count === 1 ? '' : 's'}
        </span>
        <span className="total num">{formatMoney(totals.grandTotal)}</span>
        <span className="view">
          #{tx.billNumber} <ChevronUp size={18} />
        </span>
      </button>

      <SidePanel
        className={panelOnPhone ? undefined : 'phone-hidden'}
        title={`Edit Bill #${tx.billNumber}`}
        subtitle={
          anyTime ? (
            `${placeName(tx.restaurantSnapshot.name, tx.branchSnapshot.name)} · billed ${formatDateTime(tx.finalizedAt)}`
          ) : (
            <span className={minutesLeft <= 5 ? 'danger-text' : undefined}>
              <Clock size={13} /> {minutesLeft > 0 ? `${minutesLeft} min left to edit` : `The ${BILL_EDIT_WINDOW_MINUTES}-minute edit time is over`}
            </span>
          )
        }
        onClose={() => (panelOnPhone ? setPanelOnPhone(false) : onCancel())}
        footer={
          <div className="modal-actions" style={{ marginTop: 0 }}>
            <CancelButton onClick={onCancel} disabled={busy} />
            <ConfirmButton onClick={save} busy={busy} disabled={!changed || !paid || bill.items.length === 0 || !canEdit} label="Save changes" />
          </div>
        }
      >
        {bill.items.length === 0 ? (
          <div className="alert alert-warning">A bill needs at least one item. Add food from the menu, or use Void bill instead.</div>
        ) : (
          <div className="group-lines">
            {bill.items.map((l) => (
              <div key={l.menuItemId} className="group-line">
                <div className="thumb thumb-xs">
                  <FoodImage src={l.imageUrl} alt={l.name} />
                </div>
                <span className="group-line-name" title={l.name}>
                  {splitVariant(l.name).dish}
                  {splitVariant(l.name).variant && <small className="line-variant">{splitVariant(l.name).variant}</small>}
                  <small>{formatMoney(l.unitPrice * l.quantity)}</small>
                </span>
                <div className="qty">
                  <button onClick={() => setBill((b) => setBillQuantity(b, l.menuItemId, l.quantity - 1))} aria-label={`Decrease ${l.name}`}>
                    <Minus size={15} />
                  </button>
                  <output>{l.quantity}</output>
                  <button onClick={() => setBill((b) => setBillQuantity(b, l.menuItemId, l.quantity + 1))} aria-label={`Increase ${l.name}`}>
                    <Plus size={15} />
                  </button>
                </div>
                <button className="icon-btn plain danger-text" onClick={() => setBill((b) => setBillQuantity(b, l.menuItemId, 0))} aria-label={`Remove ${l.name}`}>
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="total-box num">
          <span>New Total</span>
          <strong>{formatMoney(totals.grandTotal)}</strong>
        </div>
        {totals.grandTotal !== tx.grandTotal && (
          <div className="muted" style={{ fontSize: '0.8125rem' }}>
            Was {formatMoney(tx.grandTotal)} ({totals.grandTotal > tx.grandTotal ? 'collect' : 'return'} {formatMoney(Math.abs(totals.grandTotal - tx.grandTotal))})
          </div>
        )}
        <div>
          <div className="section-title">Payment Mode</div>
          <PaymentButtons value={payment} onChange={setPayment} allowSplit />
          {payment === 'SPLIT' && (
            <div style={{ marginTop: 10 }}>
              <SplitPayment total={totals.grandTotal} initial={wasSplit ? tx.payments : undefined} onChange={setSplitParts} />
            </div>
          )}
        </div>
        <Field label="Reason (optional)">
          {(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Added one more coffee" />}
        </Field>
      </SidePanel>
    </>
  );
}
