import {
  calculateBill,
  kitchenPending,
  type DraftDTO,
  type KitchenQty,
  type MenuItemDTO,
  type PaymentPart,
  type TransactionDTO,
} from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronUp,
  CircleCheck,
  CloudOff,
  FileText,
  Minus,
  Plus,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChangeCalculator } from '../../components/ChangeCalculator';
import { DiscountEditor } from '../../components/DiscountEditor';
import { FoodImage } from '../../components/FoodImage';
import { ManualSaleModal } from '../../components/ManualSale';
import { DishNote } from '../../components/DishNote';
import { addItemToBill, FoodGrid, setBillNote, setBillQuantity } from '../../components/FoodGrid';
import { PaymentButtons, paymentFields, printReceipt, SplitPayment, type PaymentChoice } from '../../components/PaymentButtons';
import { ConfirmDialog, Empty, Loading, Spinner } from '../../components/ui';
import { useDraftSync } from '../../hooks/useDraftSync';
import { useRootClass } from '../../hooks/useRootClass';
import { KitchenSendButton, useSendToKitchen } from '../../components/KitchenSend';
import { ReadyParcels } from '../../components/ReadyParcels';
import { api, ApiError, apiSync, errorMessage } from '../../services/api';
import { useCategories, useMenuItems } from '../../services/queries';
import { useAuth } from '../../store/auth';
import type { DraftSyncState, LocalBill } from '../../store/draftSync';
import { useToast } from '../../store/toast';
import { usePageSearch } from '../../store/topbar';
import { cx, formatMoney, newIdempotencyKey, taxedItemsText, taxLabel } from '../../utils/format';
import { splitVariant } from '../../utils/menu';

/** `compact`: only the icon while all is well (room for Add Sale); a problem always shows its words. */
function SyncStatus({ state, compact }: { state: DraftSyncState; compact?: boolean }) {
  const map: Partial<Record<DraftSyncState['status'], [string, string]>> = {
    saved: ['saved', 'Saved'],
    pending: ['', 'Saving…'],
    saving: ['', 'Saving…'],
    error: ['error', 'Not saved – retrying'],
  };
  const entry = map[state.status];
  if (!entry) return null;
  return (
    <span className={cx('sync-status', entry[0])} role="status" title={entry[1]} aria-label={entry[1]}>
      {state.status === 'saved' ? <CircleCheck /> : state.status === 'error' ? <CloudOff /> : <Spinner />}
      {(!compact || state.status === 'error') && entry[1]}
    </span>
  );
}

/** New Bill route: the counter bill, or a table group's bill when opened with ?draft=. */
export function BillingPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return <BillingView tableDraftId={params.get('draft')} onBackToTables={(tableId) => navigate(tableId ? `/tables?table=${tableId}` : '/tables')} />;
}

/**
 * Food cards on the left, the bill on the right. Used by the New Bill page and, for a table
 * group, inside the Tables page itself (so staff never leave the table screen).
 */
export function BillingView({
  tableDraftId,
  onBackToTables,
}: {
  tableDraftId: string | null;
  onBackToTables: (tableId: string | null) => void;
}) {
  const { activeBranch } = useAuth();
  const branchId = activeBranch!.id;
  const settings = activeBranch!.restaurant.settings;
  const toast = useToast();
  const queryClient = useQueryClient();
  const search = usePageSearch('Search food items...');

  const counter = useQuery({
    queryKey: ['counter-draft', branchId],
    queryFn: () => api.get<DraftDTO>('/bills/counter'),
    enabled: !tableDraftId,
    staleTime: Infinity,
  });
  const draftId = tableDraftId ?? counter.data?.id ?? null;
  const { sync, state } = useDraftSync(draftId, branchId);

  const scope = useMemo(() => ({ branchId }), [branchId]);
  const categories = useCategories(scope);
  const items = useMenuItems(scope);
  const [payment, setPayment] = useState<PaymentChoice | null>(null);
  const [splitParts, setSplitParts] = useState<PaymentPart[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [manualSale, setManualSale] = useState(false);
  // Phones: the bill is a full-screen sheet opened from the bottom "View Bill" bar.
  const [billOpen, setBillOpen] = useState(false);
  useRootClass('has-bill-bar');
  const keyRef = useRef<{ draftId: string; key: string } | null>(null);

  // Category picture for bill lines whose dish has no photo.
  const categoryIcon = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.icon])), [categories.data]);
  const itemIcon = useMemo(() => new Map((items.data ?? []).map((i) => [i.id, categoryIcon.get(i.categoryId)])), [items.data, categoryIcon]);

  const local = state.local;
  const draft = state.draft;
  const totals = useMemo(() => (local ? calculateBill(local.items, settings, local.discount) : null), [local, settings]);
  const qtyById = useMemo(() => new Map((local?.items ?? []).map((i) => [i.menuItemId, i.quantity])), [local]);
  const editable = Boolean(sync && local && draft?.status === 'ACTIVE' && state.status !== 'closed');

  const mutate = (fn: (b: LocalBill) => LocalBill) => {
    if (state.status === 'conflict' || state.status === 'rejected') sync?.acknowledge();
    sync?.update(fn);
  };

  const addItem = (item: MenuItemDTO) => {
    if (!editable || !item.isAvailable) return;
    mutate((b) => addItemToBill(b, item));
  };
  const setQty = (id: string, quantity: number) => mutate((b) => setBillQuantity(b, id, quantity));

  // Kitchen Display, a table's bill: send the order before payment so the kitchen can start (the bill
  // sends the rest). New Bill has no such button – Generate Bill sends its whole order.
  const kitchen = useSendToKitchen();
  const [sentNow, setSentNow] = useState<{ draftId: string; sent: KitchenQty[] } | null>(null);
  const kitchenSent = (sentNow && sentNow.draftId === draft?.id ? sentNow.sent : draft?.kitchenSent) ?? [];
  const toKitchen = kitchenPending(local?.items ?? [], kitchenSent);
  // A dish's note goes with its next ticket, so it is fixed once all of the dish is in the kitchen.
  const sentById = new Map(kitchenSent.map((s) => [s.menuItemId, s.quantity]));
  const sendToKitchen = async () => {
    if (!sync || !draft) return;
    const most = new Map(kitchenSent.map((s) => [s.menuItemId, s.quantity]));
    for (const l of local?.items ?? []) most.set(l.menuItemId, Math.max(most.get(l.menuItemId) ?? 0, l.quantity));
    if (await kitchen.send(draft.id, sync)) setSentNow({ draftId: draft.id, sent: [...most].map(([menuItemId, quantity]) => ({ menuItemId, quantity })) });
  };

  const finalizeBody = (current: DraftDTO) => {
    if (keyRef.current?.draftId !== current.id) keyRef.current = { draftId: current.id, key: newIdempotencyKey() };
    return { version: current.version, ...paymentFields(payment!, splitParts), idempotencyKey: keyRef.current.key };
  };
  const billed = (current: DraftDTO, transaction: TransactionDTO) => {
    keyRef.current = null;
    printReceipt(transaction); // no message: the print itself shows the bill was saved
    void sync!.load();
    void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
    finishBill(current);
  };
  const generateFailed = (err: unknown) => {
    toast.error(err);
    if (err instanceof ApiError && err.status === 409) void sync!.load();
  };

  /**
   * Saves and generates the bill within this tap (synchronous requests – the screen waits a
   * moment), so it prints at once: Safari on an iPad prints only from a tap. While an edit is
   * still being sent the tap cannot wait for it, so then it is done the usual way.
   */
  const generate = () => {
    if (!sync || !payment || (payment === 'SPLIT' && !splitParts)) return;
    try {
      if (!sync.flushSync()) return void generateAfterSave();
      const current = sync.getState().draft!;
      const res = apiSync.post<{ transaction: TransactionDTO }>(`/bills/${current.id}/finalize`, finalizeBody(current));
      billed(current, res.transaction);
    } catch (err) {
      generateFailed(err);
    }
  };
  const generateAfterSave = async () => {
    setBusy(true);
    try {
      await sync!.flushNow();
      const current = sync!.getState().draft!;
      const res = await api.post<{ transaction: TransactionDTO }>(`/bills/${current.id}/finalize`, finalizeBody(current));
      billed(current, res.transaction);
    } catch (err) {
      generateFailed(err);
    } finally {
      setBusy(false);
    }
  };

  const finishBill = (billed: DraftDTO) => {
    setPayment(null);
    setSplitParts(null);
    setBillOpen(false);
    if (billed.type === 'TABLE') {
      onBackToTables(billed.tableId);
    } else {
      void queryClient.invalidateQueries({ queryKey: ['counter-draft', branchId] });
    }
  };

  const hasItems = (local?.items.length ?? 0) > 0;
  const itemCount = local?.items.reduce((a, i) => a + i.quantity, 0) ?? 0;
  const hasUnavailable = local?.items.some((i) => i.unavailable) ?? false;
  const needSplit = payment === 'SPLIT' && !splitParts;
  // New Bill is always Take Away and a table's bill Dine In – nothing to choose.
  const hint = !payment ? 'Select a payment method to generate the bill' : needSplit && 'Enter how much was paid each way';
  const showBreakdown = Boolean(totals && (totals.discountAmount > 0 || totals.taxes.length > 0));

  return (
    <div className="billing">
      <section className="billing-main" aria-label="Food items">
        {!tableDraftId && activeBranch!.kitchenDisplay && <ReadyParcels branchId={branchId} />}
        <FoodGrid branchId={branchId} search={search} qtyById={qtyById} editable={editable} onAdd={addItem} />
      </section>

      <button type="button" className="bill-mobile-bar" onClick={() => setBillOpen(true)} aria-label="View bill">
        <span className="count">
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </span>
        <span className="total num">{formatMoney(totals?.grandTotal ?? 0)}</span>
        <span className="view">
          View Bill <ChevronUp size={18} />
        </span>
      </button>

      <aside className={cx('bill-panel', billOpen && 'mobile-open')} aria-label="Current bill">
        <div className="bill-head">
          {draft?.type === 'TABLE' && (
            <div className="bill-context">
              <button type="button" className="link-btn" onClick={() => onBackToTables(draft.tableId)}>
                <ArrowLeft size={16} /> Tables
              </button>
              <span className="badge badge-primary">
                Table {draft.tableLabel} · {draft.groupName}
              </span>
              <span className="muted">
                {draft.guestCount} guest{draft.guestCount === 1 ? '' : 's'}
              </span>
            </div>
          )}
          <div className="bill-title">
            Customer Name
            <SyncStatus state={state} compact={!tableDraftId} />
            {!tableDraftId && (
              <button type="button" className="btn btn-primary btn-sm bill-add-sale" onClick={() => setManualSale(true)} title="A sale of just an amount, without choosing dishes">
                Add Sale
              </button>
            )}
            <button type="button" className="icon-btn close-red bill-close-mobile" onClick={() => setBillOpen(false)} aria-label="Close bill" title="Back to food">
              <X />
            </button>
          </div>
          <div className="input-icon">
            <UserRound />
            <input
              className="input"
              placeholder="Enter customer name"
              value={local?.customerName ?? ''}
              maxLength={80}
              disabled={!editable}
              onChange={(e) => {
                const v = e.target.value;
                mutate((b) => ({ ...b, customerName: v }));
              }}
              aria-label="Customer name"
            />
          </div>
        </div>

        {(state.status === 'conflict' || state.status === 'rejected' || state.status === 'closed' || state.status === 'load-failed') && state.message && (
          <div style={{ padding: '0 22px 10px' }}>
            <div className={cx('alert', state.status === 'closed' ? 'alert-info' : 'alert-warning')} role="alert">
              <TriangleAlert />
              <div className="stack" style={{ gap: 6 }}>
                <span>{state.message}</span>
                {state.status === 'closed' && draft?.type === 'TABLE' && (
                  <button type="button" className="link-btn" onClick={() => onBackToTables(draft.tableId)}>
                    Back to tables
                  </button>
                )}
                {state.status === 'closed' && draft?.type === 'COUNTER' && (
                  <button className="link-btn" onClick={() => void queryClient.invalidateQueries({ queryKey: ['counter-draft', branchId] })}>
                    Start a new bill
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="bill-lines">
          {!local ? (
            state.status === 'load-failed' ? null : <Loading label="Loading bill…" />
          ) : local.items.length === 0 ? (
            <Empty icon={<FileText />} title="No items yet">
              Tap a food card to add it to this bill.
            </Empty>
          ) : (
            local.items.map((line) => (
              <div key={line.menuItemId} className={cx('bill-line', line.unavailable && 'unavailable', activeBranch!.kitchenDisplay && 'with-note')}>
                <div className="thumb">
                  <FoodImage src={line.imageUrl} alt={line.name} emoji={itemIcon.get(line.menuItemId)} />
                </div>
                <div className="info">
                  <div className="name" title={line.name}>
                    {splitVariant(line.name).dish}
                  </div>
                  {splitVariant(line.name).variant && <div className="line-variant">{splitVariant(line.name).variant}</div>}
                  <div className="price">{formatMoney(line.unitPrice)}</div>
                  {line.unavailable ? (
                    <div className="field-error">Unavailable – remove to bill</div>
                  ) : (
                    line.quantity > 1 && <div className="line-total">{formatMoney(line.unitPrice * line.quantity)}</div>
                  )}
                </div>
                <div className="qty">
                  <button onClick={() => setQty(line.menuItemId, line.quantity - 1)} disabled={!editable} aria-label={`Decrease ${line.name}`}>
                    <Minus size={18} />
                  </button>
                  <output>{line.quantity}</output>
                  <button onClick={() => setQty(line.menuItemId, line.quantity + 1)} disabled={!editable || line.unavailable} aria-label={`Increase ${line.name}`}>
                    <Plus size={18} />
                  </button>
                </div>
                <button className="icon-btn danger plain" onClick={() => setQty(line.menuItemId, 0)} disabled={!editable} aria-label={`Remove ${line.name}`}>
                  <Trash2 />
                </button>
                {activeBranch!.kitchenDisplay && (
                  <div className="bill-line-note">
                    <DishNote dish={line.name} note={line.note} onChange={(n) => mutate((b) => setBillNote(b, line.menuItemId, n))} disabled={!editable || (sentById.get(line.menuItemId) ?? 0) >= line.quantity} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="bill-foot">
          {editable && (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <DiscountEditor key={draft?.id} value={local?.discount ?? null} onApply={(d) => mutate((b) => ({ ...b, discount: d }))} />
              </div>
              {hasItems && (
                <button className="link-btn danger" onClick={() => setConfirmClear(true)}>
                  Clear
                </button>
              )}
            </div>
          )}
          {showBreakdown && totals && (
            <div className="bill-rows num">
              <div>
                <span>Subtotal</span>
                <span>{formatMoney(totals.subtotal)}</span>
              </div>
              {totals.discountAmount > 0 && (
                <div>
                  <span>Discount</span>
                  <span>− {formatMoney(totals.discountAmount)}</span>
                </div>
              )}
              {totals.taxes.map((t) => (
                <div key={`${t.name}|${t.rateBps}`}>
                  <span>
                    {taxLabel(t, settings.pricesIncludeTax)}
                    <small className="tax-items">{taxedItemsText(t, local?.items ?? [])}</small>
                  </span>
                  <span>{formatMoney(t.amount)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="bill-total num">
            <span>Total</span>
            <span>{formatMoney(totals?.grandTotal ?? 0)}</span>
          </div>
          {/* Above the payment buttons: it appears on tapping Cash without moving Cash or Generate Bill. */}
          {payment === 'CASH' && hasItems && editable && <ChangeCalculator key={draft?.id} total={totals?.grandTotal ?? 0} />}
          {payment === 'SPLIT' && hasItems && editable && <SplitPayment key={draft?.id} total={totals?.grandTotal ?? 0} onChange={setSplitParts} />}
          {/* New Bill has no Send to Kitchen: Generate Bill sends the whole order to the kitchen. A table's bill keeps it. */}
          {activeBranch!.kitchenDisplay && tableDraftId && editable && hasItems && (
            <KitchenSendButton pending={toKitchen} sending={kitchen.sending} onSend={() => void sendToKitchen()} />
          )}
          <PaymentButtons value={payment} onChange={setPayment} disabled={!editable || busy} allowSplit />
          <button className="btn btn-primary btn-lg btn-block" onClick={generate} disabled={!editable || !hasItems || !payment || needSplit || busy || hasUnavailable}>
            {busy ? <Spinner /> : <FileText />} Generate Bill
          </button>
          {/* The hint's line is always kept, so Cash / UPI / Card and Generate Bill never jump when it shows or hides. */}
          {editable && (
            <span className="field-hint" style={{ textAlign: 'center', visibility: hasItems && hint ? 'visible' : 'hidden' }} aria-hidden={!(hasItems && hint)}>
              {hint || 'Select a payment method to generate the bill'}
            </span>
          )}
        </div>
      </aside>

      {confirmClear && (
        <ConfirmDialog
          title="Clear this bill?"
          message="All items will be removed from this bill. This cannot be undone."
          confirmLabel="Clear bill"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            mutate((b) => ({ ...b, items: [], discount: null }));
            setConfirmClear(false);
          }}
        />
      )}
      {manualSale && (
        <ManualSaleModal
          onClose={() => setManualSale(false)}
          onDone={() => {
            setManualSale(false);
            void queryClient.invalidateQueries({ queryKey: ['transactions'] });
          }}
        />
      )}
      {counter.isError && !tableDraftId && <div className="toast error">{errorMessage(counter.error)}</div>}
    </div>
  );
}
