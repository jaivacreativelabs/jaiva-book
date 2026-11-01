import type { MenuItemDTO } from '@rb/shared';
import { LayoutGrid, Pin, UtensilsCrossed } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCategories, useMenuItems } from '../services/queries';
import type { LocalBill } from '../store/draftSync';
import { cx, formatMoney } from '../utils/format';
import { groupVariants, priceLabel } from '../utils/menu';
import { FoodImage } from './FoodImage';
import { Empty, Loading, Modal } from './ui';

/** Adds one of `item` to a bill (or increases its quantity). */
export function addItemToBill(bill: LocalBill, item: MenuItemDTO): LocalBill {
  const existing = bill.items.find((i) => i.menuItemId === item.id);
  if (existing) {
    return { ...bill, items: bill.items.map((i) => (i.menuItemId === item.id ? { ...i, quantity: Math.min(999, i.quantity + 1) } : i)) };
  }
  return {
    ...bill,
    items: [...bill.items, { menuItemId: item.id, name: item.name, imageUrl: item.imageUrl, unitPrice: item.price, taxable: item.taxable, taxRateBps: item.taxRateBps, extraTaxes: item.extraTaxes, quantity: 1, unavailable: false, note: '' }],
  };
}

/** Sets the kitchen note of a line ("no onion"). */
export function setBillNote(bill: LocalBill, menuItemId: string, note: string): LocalBill {
  return { ...bill, items: bill.items.map((i) => (i.menuItemId === menuItemId ? { ...i, note } : i)) };
}

/** Changes a line's quantity; 0 removes it. */
export function setBillQuantity(bill: LocalBill, menuItemId: string, quantity: number): LocalBill {
  return {
    ...bill,
    items:
      quantity <= 0
        ? bill.items.filter((i) => i.menuItemId !== menuItemId)
        : bill.items.map((i) => (i.menuItemId === menuItemId ? { ...i, quantity: Math.min(999, quantity) } : i)),
  };
}

/** Each tap on a size / type adds one more of it to the bill; the picker stays open until Done. */
function VariantPicker({
  dish,
  variants,
  qtyById,
  onPick,
  onClose,
}: {
  dish: MenuItemDTO;
  variants: MenuItemDTO[];
  qtyById: Map<string, number>;
  onPick: (variant: MenuItemDTO) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={dish.name} onClose={onClose} width={480}>
      <div className="variant-list" role="list">
        {variants.map((v) => {
          const qty = qtyById.get(v.id);
          return (
            <button key={v.id} type="button" className="variant-btn" disabled={!v.isAvailable} onClick={() => onPick(v)} aria-label={`Add ${v.name}`}>
              <span className="variant-name">
                {v.variantName}
                {v.variantQty && <small className="variant-qty">{v.variantQty}</small>}
              </span>
              {!v.isAvailable ? <span className="muted">Sold out</span> : qty ? <span className="food-qty-badge">{qty}</span> : null}
              <span className="variant-price">{formatMoney(v.price)}</span>
            </button>
          );
        })}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

const FoodCard = memo(function FoodCard({
  item,
  variants,
  qty,
  available,
  editable,
  emoji,
  onPress,
}: {
  item: MenuItemDTO;
  variants: MenuItemDTO[] | undefined;
  qty: number;
  available: boolean;
  editable: boolean;
  emoji: string | undefined;
  onPress: (item: MenuItemDTO) => void;
}) {
  return (
    <div
      className={cx('food-card', !available && 'disabled')}
      onClick={() => onPress(item)}
      role="button"
      tabIndex={available ? 0 : -1}
      aria-disabled={!available}
      aria-label={variants ? `Choose ${item.name}` : `Add ${item.name}`}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPress(item))}
    >
      <div className="food-media">
        <FoodImage src={item.imageUrl} alt={item.name} emoji={emoji} />
      </div>
      {qty ? <span className="food-qty-badge">{qty}</span> : null}
      {!available && <span className="unavailable-tag">Unavailable</span>}
      {available && item.pinned && (
        <span className="pin-mark" title="Pinned">
          <Pin size={14} />
        </span>
      )}
      <div className="food-body">
        <div style={{ minWidth: 0 }}>
          <div className="food-name">{item.name}</div>
          <div className="food-price">{priceLabel(item, variants)}</div>
        </div>
        <button
          className="btn btn-primary"
          tabIndex={-1}
          disabled={!available || !editable}
          onClick={(e) => {
            e.stopPropagation();
            onPress(item);
          }}
        >
          {variants ? 'Choose' : 'Add'}
        </button>
      </div>
    </div>
  );
});

/** Category chips + food cards for the branch menu. Used by New Bill and table ordering. */
export function FoodGrid({
  branchId,
  search,
  qtyById,
  editable,
  onAdd,
}: {
  branchId: string;
  search: string;
  qtyById: Map<string, number>;
  editable: boolean;
  onAdd: (item: MenuItemDTO) => void;
}) {
  const scope = useMemo(() => ({ branchId }), [branchId]);
  const categories = useCategories(scope);
  const items = useMenuItems(scope);
  const [category, setCategory] = useState<string>('all');
  const [picking, setPicking] = useState<MenuItemDTO | null>(null);

  const activeCategoryIds = useMemo(() => new Set((categories.data ?? []).map((c) => c.id)), [categories.data]);
  // Category picture for dishes without a photo, so they stay recognisable.
  const categoryIcon = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.icon])), [categories.data]);
  const { dishes, variantsOf } = useMemo(() => groupVariants(items.data ?? []), [items.data]);
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (i: MenuItemDTO) => i.name.toLowerCase().includes(q) || (variantsOf.get(i.id) ?? []).some((v) => v.variantName.toLowerCase().includes(q));
    return dishes.filter((i) => activeCategoryIds.has(i.categoryId) && (category === 'all' || i.categoryId === category) && (!q || matches(i)));
  }, [dishes, variantsOf, activeCategoryIds, category, search]);

  const variantsFor = (item: MenuItemDTO) => variantsOf.get(item.id);
  const orderable = (item: MenuItemDTO) => item.isAvailable && (!variantsFor(item) || variantsFor(item)!.some((v) => v.isAvailable));
  const add = (item: MenuItemDTO) => {
    if (!editable || !orderable(item)) return;
    if (variantsFor(item)) setPicking(item);
    else onAdd(item);
  };
  // One handler for every card that never changes, so a tap re-draws only the card whose count changed.
  const addRef = useRef(add);
  useLayoutEffect(() => {
    addRef.current = add;
  });
  const press = useCallback((item: MenuItemDTO) => addRef.current(item), []);
  // Stable, so the open picker keeps its focus while the bill updates behind it.
  const closePicker = useCallback(() => setPicking(null), []);

  return (
    <>
      <div className="chips" role="tablist" aria-label="Categories">
        <button className={cx('chip', category === 'all' && 'active')} onClick={() => setCategory('all')} role="tab" aria-selected={category === 'all'}>
          <LayoutGrid /> All
        </button>
        {(categories.data ?? []).map((c) => (
          <button key={c.id} className={cx('chip', category === c.id && 'active')} onClick={() => setCategory(c.id)} role="tab" aria-selected={category === c.id}>
            {c.icon && <span className="chip-icon">{c.icon}</span>}
            {c.name}
          </button>
        ))}
      </div>

      {items.isLoading ? (
        <Loading label="Loading menu…" />
      ) : visibleItems.length === 0 ? (
        <Empty icon={<UtensilsCrossed />} title={search ? 'No items match your search' : 'No items in the menu yet'}>
          {!search && <Link to="/menu">Add food items in Menu</Link>}
        </Empty>
      ) : (
        <div className="food-grid">
          {visibleItems.map((item) => {
            const variants = variantsFor(item);
            const qty = variants ? variants.reduce((a, v) => a + (qtyById.get(v.id) ?? 0), 0) : (qtyById.get(item.id) ?? 0);
            return (
              <FoodCard
                key={item.id}
                item={item}
                variants={variants}
                qty={qty}
                available={orderable(item)}
                editable={editable}
                emoji={categoryIcon.get(item.categoryId)}
                onPress={press}
              />
            );
          })}
        </div>
      )}
      {picking && (
        <VariantPicker
          dish={picking}
          variants={variantsFor(picking) ?? []}
          qtyById={qtyById}
          onClose={closePicker}
          onPick={(v) => {
            // A variant without its own photo shows the dish's photo on the bill.
            onAdd({ ...v, imageUrl: v.imageUrl ?? picking.imageUrl });
          }}
        />
      )}
    </>
  );
}
