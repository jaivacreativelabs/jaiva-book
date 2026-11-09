import {
  bpsToPercent,
  LIMITS,
  paiseToRupeesInput,
  parsePercentToBps,
  parseRupeesToPaise,
  type CategoryDTO,
  type MenuItemDTO,
  type TaxSettings,
} from '@rb/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  Check,
  CirclePlus,
  Info,
  GripVertical,
  Layers,
  LayoutGrid,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  TriangleAlert,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FoodImage } from '../../components/FoodImage';
import { byOrder, mergeOrder, SortableItem, SortableList } from '../../components/Sortable';
import { CancelButton, ConfirmButton, ConfirmDialog, Empty, Field, Loading, Modal, PageHeader, SidePanel, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../services/api';
import { menuKeys, scopeQuery, useCategories, useMenuItems, type MenuScope } from '../../services/queries';
import { useAuth } from '../../store/auth';
import { useToast } from '../../store/toast';
import { usePageSearch } from '../../store/topbar';
import { cx, formatMoney } from '../../utils/format';
import { shrinkImage } from '../../utils/image';
import { groupVariants, priceLabel } from '../../utils/menu';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
/** Common GST rates for food in India, offered as one-tap choices (any % can be typed). */
const GST_RATES = [0, 5, 12, 18];

function useScopedApi(scope: MenuScope) {
  const opts = { query: scopeQuery(scope), branchId: scope.branchId ?? null };
  return {
    post: <T,>(path: string, body?: unknown) => api.post<T>(path, body, opts),
    patch: <T,>(path: string, body?: unknown) => api.patch<T>(path, body, opts),
    put: <T,>(path: string, body?: unknown) => api.put<T>(path, body, opts),
    del: <T,>(path: string) => api.delete<T>(path, opts),
    upload: <T,>(path: string, form: FormData) => api.upload<T>(path, form, opts),
  };
}

// ---------------- Inline category creation ----------------

// Emoji 13 and older, so they show on older iPads too.
const CATEGORY_ICONS = [
  // meals, tiffin and rice
  '🍽️', '🥞', '🍛', '🍚', '🍙', '🍘', '🍥', '🍲', '🥘', '🍜', '🍝', '🍱',
  '🥡', '🥣', '🥗', '🫓', '🥙', '🌯', '🥪', '🍔', '🍕', '🌮', '🥟', '🍟',
  '🌭', '🍿', '🥨', '🥐', '🥖', '🍞', '🥯', '🧇', '🧈', '🧀', '🫕', '🥫',
  // egg, meat and seafood
  '🍳', '🥚', '🍗', '🍖', '🥩', '🥓', '🐟', '🍤', '🦐', '🦀', '🦑', '🐙',
  '🍣', '🐔', '🐐', '🐑',
  // vegetables, spices and nuts
  '🧆', '🌶️', '🧄', '🧅', '🥔', '🥕', '🌽', '🥦', '🥬', '🥒', '🍅', '🍆',
  '🫑', '🥑', '🍄', '🥜', '🌰', '🌿', '🍃', '🧂',
  // fruits
  '🍎', '🍏', '🍐', '🍊', '🍋', '🍌', '🍍', '🥭', '🍇', '🍓', '🫐', '🍒',
  '🍑', '🥝', '🍈', '🍉', '🥥',
  // drinks
  '☕', '🍵', '🫖', '🧋', '🥤', '🧃', '🥛', '🍹', '🍸', '🧉', '🍶', '🧊',
  '🍺', '🍷', '🍼',
  // sweets and desserts
  '🍦', '🍧', '🍨', '🍰', '🎂', '🧁', '🥧', '🍮', '🍩', '🍪', '🍫', '🍬',
  '🍭', '🍯', '🥮', '🍡',
  // specials
  '⭐', '🔥', '🎉', '🥄', '🍴', '🥢',
];

/** Picks a category's icon from a grid instead of typing an emoji. */
function IconPicker({ value, onChange, small }: { value: string; onChange: (icon: string) => void; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="icon-picker" ref={ref}>
      <button
        type="button"
        className={cx('icon-picker-btn', small && 'small', !value && 'no-icon')}
        onClick={() => setOpen((o) => !o)}
        aria-label="Choose an icon"
        aria-expanded={open}
        title="Choose an icon"
      >
        {value || '🍽️'}
      </button>
      {open && (
        <div className="icon-picker-grid" role="listbox" aria-label="Icons">
          {CATEGORY_ICONS.map((i) => (
            <button
              type="button"
              key={i}
              role="option"
              aria-selected={value === i}
              className={cx(value === i && 'active')}
              onClick={() => {
                onChange(i);
                setOpen(false);
              }}
            >
              {i}
            </button>
          ))}
          {value && (
            <button
              type="button"
              className="icon-picker-none"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              No icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CreateCategoryForm({ scope, onCreated, prominent }: { scope: MenuScope; onCreated: (c: CategoryDTO) => void; prominent: boolean }) {
  const scoped = useScopedApi(scope);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return setError('Enter a category name');
    setBusy(true);
    setError(null);
    try {
      const c = await scoped.post<CategoryDTO>('/menu/categories', { name: name.trim(), ...(icon.trim() && { icon: icon.trim() }) });
      await queryClient.invalidateQueries({ queryKey: menuKeys.all });
      toast.success(`Category “${c.name}” created`);
      setName('');
      setIcon('');
      onCreated(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={prominent ? 'create-category-box' : 'stack'} style={prominent ? undefined : { gap: 8 }}>
      {prominent && (
        <div>
          <div className="section-title" style={{ marginBottom: 4 }}>
            Create Category
          </div>
          <span className="field-hint">Your menu has no categories yet. Create one (e.g. Breakfast) to start adding food.</span>
        </div>
      )}
      <div className="row" style={{ alignItems: 'stretch' }}>
        <IconPicker value={icon} onChange={setIcon} />
        <input
          className="input"
          placeholder="Category name"
          value={name}
          maxLength={50}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void create())}
          aria-label="Category name"
          autoFocus={prominent}
        />
      </div>
      {error && <span className="field-error">{error}</span>}
      <button type="button" className={cx('btn', prominent ? 'btn-primary' : 'btn-soft')} onClick={create} disabled={busy}>
        {busy ? <Spinner /> : <CirclePlus />} Create Category
      </button>
    </div>
  );
}

// ---------------- Variants (sizes / types) ----------------

interface VariantRow {
  key: string;
  id?: string;
  name: string;
  /** How much it is, e.g. "2 pcs" */
  qty: string;
  price: string;
}
let rowSeq = 0;
const toRow = (v: MenuItemDTO): VariantRow => ({
  key: v.id,
  id: v.id,
  name: v.variantName,
  qty: v.variantQty,
  price: paiseToRupeesInput(v.price),
});

interface TaxRow {
  key: string;
  name: string;
  rate: string;
}

/** Other taxes on a food besides GST (e.g. Service charge 10 %): a name and a % each. */
function ExtraTaxesEditor({ rows, onChange, error }: { rows: TaxRow[]; onChange: (rows: TaxRow[]) => void; error?: string }) {
  const update = (key: string, patch: Partial<TaxRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <span className="field-label">
        Tax <span className="muted">(optional – any other tax, e.g. Service charge)</span>
      </span>
      {rows.length > 0 && (
        <div className="variant-rows">
          {rows.map((r) => (
            <div key={r.key} className="tax-row">
              <input
                className="input"
                value={r.name}
                maxLength={30}
                placeholder="Tax name"
                onChange={(e) => update(r.key, { name: e.target.value })}
                aria-label="Tax name"
              />
              <div className="input-suffix">
                <input className="input" inputMode="decimal" value={r.rate} placeholder="0" onChange={(e) => update(r.key, { rate: e.target.value })} aria-label={`${r.name || 'Tax'} percent`} />
                <span>%</span>
              </div>
              <button type="button" className="icon-btn plain danger-text" onClick={() => onChange(rows.filter((x) => x.key !== r.key))} aria-label={`Remove ${r.name || 'tax'}`}>
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      )}
      {rows.length < LIMITS.maxTaxes && (
        <button type="button" className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, { key: `tax-${++rowSeq}`, name: '', rate: '' }])}>
          <Plus size={16} /> Add tax
        </button>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/** Rows of name, quantity and price. For a main-menu dish seen from a branch, changes apply to that branch only. */
function VariantsEditor({ rows, onChange, error }: { rows: VariantRow[]; onChange: (rows: VariantRow[]) => void; error?: string }) {
  const update = (key: string, patch: Partial<VariantRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <span className="field-label">
        Sizes / variants <span className="muted">(optional – e.g. Half / Full, Plain / Masala)</span>
      </span>
      {rows.length > 0 && (
        <div className="variant-rows">
          <div className="variant-row variant-head" aria-hidden="true">
            <span>Variant</span>
            <span>Qty</span>
            <span>Price</span>
            <span />
          </div>
          {rows.map((r) => (
            <div key={r.key} className="variant-row">
              <input
                className="input"
                value={r.name}
                maxLength={30}
                placeholder="e.g. Half"
                onChange={(e) => update(r.key, { name: e.target.value })}
                aria-label="Variant name"
              />
              <input
                className="input"
                value={r.qty}
                maxLength={20}
                placeholder="2 pcs"
                onChange={(e) => update(r.key, { qty: e.target.value })}
                aria-label={`${r.name || 'Variant'} quantity`}
              />
              <div className="input-prefix">
                <span>₹</span>
                <input className="input" inputMode="decimal" value={r.price} placeholder="0" onChange={(e) => update(r.key, { price: e.target.value })} aria-label={`${r.name || 'Variant'} price`} />
              </div>
              <button type="button" className="icon-btn plain danger-text" onClick={() => onChange(rows.filter((x) => x.key !== r.key))} aria-label={`Remove ${r.name || 'variant'}`}>
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      )}
      {rows.length < LIMITS.maxVariants && (
        <button
          type="button"
          className="btn btn-soft btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onChange([...rows, { key: `new-${++rowSeq}`, name: '', qty: '', price: '' }])}
        >
          <Plus size={16} /> Add a variant
        </button>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// ---------------- Add / edit item ----------------

function ItemPanel({
  scope,
  item,
  variants,
  categories,
  taxSettings,
  onClose,
}: {
  scope: MenuScope;
  item: MenuItemDTO | null;
  variants: MenuItemDTO[];
  categories: CategoryDTO[];
  taxSettings: TaxSettings;
  onClose: () => void;
}) {
  const scoped = useScopedApi(scope);
  const queryClient = useQueryClient();
  const toast = useToast();
  const isEdit = Boolean(item);
  const shared = Boolean(item?.isShared); // main-menu item seen from a branch: changes are for this branch only
  const usable = categories.filter((c) => c.status === 'ACTIVE' && (scope.branchId ? true : c.branchId === null));

  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item ? paiseToRupeesInput(item.price) : '');
  const [description, setDescription] = useState(item?.description ?? '');
  // GST % of this food. Older items without their own rate show the restaurant's rate they pay today.
  // A new food starts with its category's GST (else the restaurant's), until a GST is picked here.
  const restaurantTaxBps = taxSettings.taxes.reduce((a, t) => a + t.rateBps, 0);
  const startingTax = (catId: string) => bpsToPercent(categories.find((c) => c.id === catId)?.taxRateBps ?? restaurantTaxBps);
  const [tax, setTaxValue] = useState(() =>
    item ? bpsToPercent(item.taxRateBps ?? (item.taxable ? restaurantTaxBps : 0)) : startingTax(''),
  );
  const [taxPicked, setTaxPicked] = useState(isEdit);
  const setTax = (v: string) => {
    setTaxValue(v);
    setTaxPicked(true);
  };
  const chooseCategory = (id: string) => {
    setCategoryId(id);
    if (!taxPicked) setTaxValue(startingTax(id));
  };
  const [extraTaxes, setExtraTaxes] = useState<TaxRow[]>(() =>
    (item?.extraTaxes ?? []).map((t) => ({ key: `tax-${++rowSeq}`, name: t.name, rate: bpsToPercent(t.rateBps) })),
  );
  // There is no sold-out switch in this form: saving a dish keeps it orderable.
  const isAvailable = true;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [rows, setRows] = useState<VariantRow[]>(() => variants.map(toRow));
  const hasVariants = rows.length > 0;

  const pickFile = async (picked: File | null) => {
    if (!picked) return;
    if (!ACCEPTED.includes(picked.type)) return setErrors((e) => ({ ...e, image: 'Use a JPEG, PNG or WebP image' }));
    // Shrunk first, so large phone photos are accepted and the menu stays quick to load.
    const f = await shrinkImage(picked);
    if (f.size > LIMITS.maxImageBytes) return setErrors((e) => ({ ...e, image: 'Image must be 2 MB or smaller' }));
    setErrors(({ image: _i, ...rest }) => rest);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: menuKeys.all });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const paise = parseRupeesToPaise(price);
    if (!categoryId) next.category = 'Select a category';
    if (!name.trim()) next.name = 'Enter the item name';
    if (!hasVariants && paise === null) next.price = 'Enter a price like 30 or 49.50';
    else if (!hasVariants && paise! > LIMITS.maxPricePaise) next.price = 'Price is too high';
    const variantRows = rows.map((r) => ({ ...r, paise: parseRupeesToPaise(r.price) }));
    const names = variantRows.map((r) => r.name.trim().toLowerCase());
    if (names.some((n) => !n)) next.variants = 'Give every variant a name, e.g. Half or Large';
    else if (new Set(names).size !== names.length) next.variants = 'Each variant name only once';
    else if (variantRows.some((r) => r.paise === null || r.paise > LIMITS.maxPricePaise)) next.variants = 'Enter a price for every variant, like 50 or 49.50';
    const taxBps = parsePercentToBps(tax || '0');
    if (taxBps === null || taxBps > 10_000) next.tax = 'Enter a tax % like 5 or 2.5';
    const extras = extraTaxes.map((t) => ({ name: t.name.trim(), rateBps: parsePercentToBps(t.rate || '0') }));
    if (extras.some((t) => !t.name)) next.extraTaxes = 'Give every tax a name, e.g. Service charge';
    else if (extras.some((t) => t.rateBps === null || t.rateBps > 10_000)) next.extraTaxes = 'Enter a % for every tax, like 10 or 2.5';
    else if (new Set(extras.map((t) => t.name.toLowerCase())).size !== extras.length) next.extraTaxes = 'Each tax name only once';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      let saved: MenuItemDTO;
      // A dish with variants shows its lowest variant price.
      const dishPrice = hasVariants ? Math.min(...variantRows.map((r) => r.paise!)) : paise!;
      if (shared) {
        // The main-menu price stays the dish's lowest variant price; a branch sets variant prices only.
        const body = { categoryId, name: name.trim(), description: description.trim(), isAvailable, taxRateBps: taxBps, extraTaxes: extras };
        saved = await scoped.patch<MenuItemDTO>(`/menu/items/${item!.id}`, hasVariants ? body : { ...body, price: paise });
      } else {
        const body = { categoryId, name: name.trim(), description: description.trim(), price: dishPrice, taxRateBps: taxBps, taxable: taxBps! > 0, extraTaxes: extras, isAvailable };
        saved = isEdit ? await scoped.patch<MenuItemDTO>(`/menu/items/${item!.id}`, body) : await scoped.post<MenuItemDTO>('/menu/items', body);
      }
      if (hasVariants || variants.length) {
        await scoped.put(`/menu/items/${saved.id}/variants`, {
          variants: variantRows.map((r) => ({ ...(r.id && { id: r.id }), name: r.name.trim(), qty: r.qty.trim(), price: r.paise!, isAvailable: true })),
        });
      }
      // For a shared item in a branch the server stores this as the branch's own photo.
      if (file) {
        const form = new FormData();
        form.append('image', file);
        try {
          saved = await scoped.upload<MenuItemDTO>(`/menu/items/${saved.id}/image`, form);
        } catch (err) {
          toast.error(`Saved, but the photo failed: ${errorMessage(err)}`);
        }
      }
      await refresh();
      if (isEdit) {
        toast.success(`“${saved.name}” updated`);
        onClose();
      } else {
        toast.success(`“${saved.name}” added to the menu`);
        // Keep the category for quick entry of the next item.
        setName('');
        setPrice('');
        setDescription('');
        setFile(null);
        setPreview(null);
        setRows([]);
      }
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const resetOverride = async () => {
    try {
      await scoped.del(`/menu/items/${item!.id}/override`);
      await refresh();
      toast.success('Restored the main menu price');
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  const removeImage = async () => {
    try {
      await scoped.del(`/menu/items/${item!.id}/image`);
      await refresh();
      toast.success('Image removed');
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  const archive = async () => {
    try {
      await scoped.post(`/menu/items/${item!.id}/archive`);
      await refresh();
      toast.success(`“${item!.name}” removed from the menu`);
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  const noCategories = usable.length === 0;
  const selectedCategory = usable.find((c) => c.id === categoryId);
  const photo = preview ?? item?.imageUrl ?? null;
  // Numbered steps help staff follow the form top to bottom.
  let stepNo = 0;
  const step = (children: React.ReactNode) => (
    <span className="step-label">
      <span className="step-no">{++stepNo}</span>
      {children}
    </span>
  );

  return (
    <SidePanel title={isEdit ? 'Edit Food' : 'Add Food'} subtitle={isEdit ? item!.name : 'Photo → category → name → price'} onClose={onClose}>
      {!isEdit && noCategories && <CreateCategoryForm scope={scope} prominent onCreated={(c) => setCategoryId(c.id)} />}

      {shared && (
        <div className="alert alert-info">
          <Info />
          <span>This food comes from the main menu. Changes you make here are for this location only.</span>
        </div>
      )}

      <form className={cx('stack', !isEdit && noCategories && 'form-section-disabled')} style={{ gap: 18 }} onSubmit={submit} aria-disabled={!isEdit && noCategories}>
        {!isEdit && noCategories && <div className="section-title">Create Food</div>}

        <div className="field">
          <span className="field-label">
            {step(<>
              Food photo <span className="muted">(optional)</span>
            </>)}
          </span>
          <label className={cx('photo-box', photo && 'has-photo')}>
            {photo ? (
              <>
                <FoodImage src={photo} alt="Food photo" />
                <span className="photo-change">
                  <Camera size={16} /> Change photo
                </span>
              </>
            ) : (
              <span className="photo-empty">
                <Camera />
                <strong>Tap here to add a photo</strong>
                <small>Take a picture or choose one</small>
              </span>
            )}
            <input type="file" accept={ACCEPTED.join(',')} hidden onChange={(e) => void pickFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <span className="field-hint">New photo selected – press {isEdit ? 'Save' : 'Add Food'} to keep it.</span>}
          {isEdit && !file && (shared ? item!.imageOverridden : item?.imageUrl) && (
            <button type="button" className="link-btn danger" onClick={removeImage}>
              <Trash2 size={14} /> {shared ? 'Use the main menu photo again' : 'Remove photo'}
            </button>
          )}
          {errors.image && <span className="field-error">{errors.image}</span>}
        </div>

        <div className="field">
          <span className="field-label">
            {step(<>Category</>)}
          </span>
          <div className="cat-picker" role="radiogroup" aria-label="Category">
            {usable.map((c) => (
              <button
                type="button"
                key={c.id}
                role="radio"
                aria-checked={categoryId === c.id}
                className={cx('cat-tile', categoryId === c.id && 'active')}
                onClick={() => chooseCategory(c.id)}
              >
                {categoryId === c.id && <Check className="cat-tile-check" />}
                <span className="cat-tile-icon">{c.icon || '🍽️'}</span>
                <span className="cat-tile-name">{c.name}</span>
              </button>
            ))}
            {!noCategories && (
              <button type="button" className={cx('cat-tile cat-tile-new', showNewCategory && 'active')} onClick={() => setShowNewCategory((s) => !s)}>
                <span className="cat-tile-icon">{showNewCategory ? <X /> : <Plus />}</span>
                <span className="cat-tile-name">{showNewCategory ? 'Close' : 'New'}</span>
              </button>
            )}
          </div>
          {errors.category && <span className="field-error">{errors.category}</span>}
          {showNewCategory && (
            <CreateCategoryForm
              scope={scope}
              prominent={false}
              onCreated={(c) => {
                setCategoryId(c.id);
                setShowNewCategory(false);
              }}
            />
          )}
        </div>

        <Field
          label={step(
            <>
              Food name {selectedCategory?.icon && <span aria-hidden="true">{selectedCategory.icon}</span>}
            </>,
          )}
          error={errors.name}
        >
          {(id) => <input id={id} className="input input-xl" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Masala Dosa" />}
        </Field>
        {!hasVariants && (
          <Field label={step(<>Price</>)} error={errors.price} hint={shared && item!.hasOverride ? `Main menu price: ${formatMoney(item!.basePrice)}` : undefined}>
            {(id) => (
              <div className="input-prefix input-prefix-xl">
                <span>₹</span>
                <input id={id} className="input input-xl" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
              </div>
            )}
          </Field>
        )}
        <VariantsEditor rows={rows} onChange={setRows} error={errors.variants} />

        <Field
          label="GST %"
          error={errors.tax}
          hint={
            !isEdit && !taxPicked && categories.find((c) => c.id === categoryId)?.taxRateBps != null
              ? 'This category’s GST – tap another to change it for this food'
              : shared
              ? undefined
              : Number(parsePercentToBps(tax || '0')) > 0
                ? `CGST + SGST, ${taxSettings.pricesIncludeTax ? 'included in' : 'added to'} the price on the bill`
                : 'No GST on this food'
          }
        >
          {(id) => (
            <div className="tax-picker">
              {GST_RATES.map((r) => (
                <button
                  type="button"
                  key={r}
                  className={cx('chip chip-sm', parsePercentToBps(tax || '0') === r * 100 && 'active')}
                  onClick={() => setTax(String(r))}
                >
                  {r === 0 ? 'No GST' : `${r}%`}
                </button>
              ))}
              <div className="input-suffix">
                <input
                  id={id}
                  className="input"
                  inputMode="decimal"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                  placeholder="0"
                  aria-label="GST percent"
                />
                <span>%</span>
              </div>
            </div>
          )}
        </Field>
        <ExtraTaxesEditor rows={extraTaxes} onChange={setExtraTaxes} error={errors.extraTaxes} />

        <details className="more-options">
          <summary>More options (description)</summary>
          <Field label="Description">
            {(id) => <textarea id={id} className="textarea" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />}
          </Field>
        </details>

        {errors.form && <div className="alert alert-danger">{errors.form}</div>}
        <div className="form-actions">
          <CancelButton onClick={onClose} disabled={busy} className="btn-lg" />
          <ConfirmButton type="submit" busy={busy} disabled={!isEdit && noCategories} label={isEdit ? 'Save' : 'Add Food'} className="btn-lg" />
        </div>
        {shared && item!.hasOverride && (
          <button type="button" className="btn btn-outline btn-block" onClick={resetOverride}>
            Use main menu price
          </button>
        )}
        {isEdit && (
          <button type="button" className="btn btn-danger-soft btn-block" onClick={() => setConfirmArchive(true)}>
            <Trash2 /> Remove this food from the menu
          </button>
        )}
      </form>
      {confirmArchive && (
        <ConfirmDialog
          title={`Remove “${item!.name}”?`}
          message="This food disappears from the menu and billing. Past bills still show it."
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmArchive(false)}
          onConfirm={archive}
        />
      )}
    </SidePanel>
  );
}

// ---------------- Category management ----------------

/**
 * One GST % for a whole category: every dish in it gets it on Save, and new dishes added to it
 * start with it. A single dish can still be given its own GST afterwards (Edit food).
 */
function CategoryGstDialog({ category, dishCount, onSave, onClose }: { category: CategoryDTO; dishCount: number; onSave: (bps: number) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(category.taxRateBps == null ? '' : bpsToPercent(category.taxRateBps));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bps = value.trim() ? parsePercentToBps(value) : null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bps === null || bps > 10_000) return setError('Enter a GST % like 5 or 2.5');
    setBusy(true);
    try {
      await onSave(bps);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`GST for ${category.name}`} onClose={onClose} width={420}>
      <form className="stack" onSubmit={save}>
        <div className="tax-picker">
          {GST_RATES.map((r) => (
            <button type="button" key={r} className={cx('chip chip-sm', bps === r * 100 && 'active')} onClick={() => (setValue(String(r)), setError(''))}>
              {r === 0 ? 'No GST' : `${r}%`}
            </button>
          ))}
          <div className="input-suffix">
            <input className="input" inputMode="decimal" value={value} onChange={(e) => (setValue(e.target.value), setError(''))} placeholder="0" aria-label="GST percent" />
            <span>%</span>
          </div>
        </div>
        {error ? (
          <div className="alert alert-danger">{error}</div>
        ) : (
          <div className="muted">
            {dishCount === 0
              ? 'New foods added to this category will start with this GST.'
              : `All ${dishCount} food${dishCount === 1 ? '' : 's'} in ${category.name} will get this GST, and new foods added to it will start with it. You can still set a different GST for one food in Edit food.`}
          </div>
        )}
        <div className="modal-actions">
          <CancelButton onClick={onClose} disabled={busy} />
          <ConfirmButton type="submit" busy={busy} label="Save" />
        </div>
      </form>
    </Modal>
  );
}

function CategoriesPanel({ scope, onClose }: { scope: MenuScope; onClose: () => void }) {
  const scoped = useScopedApi(scope);
  const queryClient = useQueryClient();
  const toast = useToast();
  const categories = useCategories(scope, true);
  const items = useMenuItems(scope);
  const [editing, setEditing] = useState<{ id: string; name: string; icon: string } | null>(null);
  const [deleting, setDeleting] = useState<CategoryDTO | null>(null);
  const [gstFor, setGstFor] = useState<CategoryDTO | null>(null);
  const dishesIn = (c: CategoryDTO) => (items.data ?? []).filter((i) => !i.parentId && i.editable && i.categoryId === c.id).length;
  const list = categories.data ?? [];
  const own = list.filter((c) => c.editable);
  const refresh = () => queryClient.invalidateQueries({ queryKey: menuKeys.all });

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      await refresh();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err);
    }
  };
  /** Dragged into a new order: shown at once, then saved. */
  const reorder = (ids: string[]) => {
    queryClient.setQueryData(menuKeys.categories(scope, true), (old: CategoryDTO[] | undefined) => old && byOrder(old, ids));
    void run(() => scoped.post('/menu/categories/reorder', { ids }));
  };

  return (
    <SidePanel title="Categories" subtitle="Create, rename, reorder and hide categories" onClose={onClose}>
      <CreateCategoryForm scope={scope} prominent={list.length === 0} onCreated={() => undefined} />
      <hr className="divider" />
      {categories.isLoading ? (
        <Loading />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {own.length > 1 && <div className="muted drag-hint">Press and hold a category, then drag it up or down.</div>}
          <SortableList ids={own.map((c) => c.id)} onReorder={reorder} layout="column">
          {list.map((c) => {
            const Row = c.editable ? SortableItem : 'div';
            return (
              <Row key={c.id} id={c.id} disabled={editing?.id === c.id} className={cx('cat-row', c.status === 'INACTIVE' && 'inactive')}>
                {editing?.id === c.id ? (
                  <>
                    <IconPicker small value={editing.icon} onChange={(icon) => setEditing({ ...editing, icon })} />
                    <input className="input input-sm" value={editing.name} maxLength={50} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Name" autoFocus />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() =>
                        void run(() => scoped.patch(`/menu/categories/${c.id}`, { name: editing.name.trim(), icon: editing.icon.trim() }), 'Category renamed').then(() => setEditing(null))
                      }
                    >
                      Save
                    </button>
                    <button className="icon-btn close-red" onClick={() => setEditing(null)} aria-label="Cancel">
                      <X />
                    </button>
                  </>
                ) : (
                  <>
                    {c.editable && <GripVertical className="drag-grip" aria-hidden="true" />}
                    <span className="cat-icon">{c.icon || '•'}</span>
                    <span className="cat-row-name">
                      <strong>{c.name}</strong>
                      {(c.isShared || c.status === 'INACTIVE' || c.taxRateBps != null) && (
                        <span className="cat-row-badges">
                          {c.taxRateBps != null && <span className="badge badge-green badge-sm">{c.taxRateBps === 0 ? 'No GST' : `GST ${bpsToPercent(c.taxRateBps)}%`}</span>}
                          {c.isShared && <span className="badge badge-gray badge-sm">Shared</span>}
                          {c.status === 'INACTIVE' && <span className="badge badge-amber badge-sm">Hidden</span>}
                        </span>
                      )}
                    </span>
                    {c.editable && (
                      <span className="cat-row-actions">
                        <button className="btn btn-outline btn-sm cat-gst-btn" onClick={() => setGstFor(c)} title={`Set one GST for every food in ${c.name}`}>
                          GST
                        </button>
                        <button className="icon-btn plain" onClick={() => setEditing({ id: c.id, name: c.name, icon: c.icon })} aria-label={`Rename ${c.name}`}>
                          <Pencil />
                        </button>
                        <button className="icon-btn plain danger-text" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`} title="Delete">
                          <Trash2 />
                        </button>
                        <label className="switch" title={c.status === 'ACTIVE' ? 'Visible' : 'Hidden'}>
                          <input
                            type="checkbox"
                            checked={c.status === 'ACTIVE'}
                            onChange={(e) => void run(() => scoped.patch(`/menu/categories/${c.id}/status`, { status: e.target.checked ? 'ACTIVE' : 'INACTIVE' }))}
                            aria-label={`${c.name} visible`}
                          />
                        </label>
                      </span>
                    )}
                  </>
                )}
              </Row>
            );
          })}
          </SortableList>
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          message={
            deleting.isShared
              ? 'It is removed from this restaurant’s menu only – other restaurants keep it. Only an empty category can be deleted.'
              : 'Only an empty category can be deleted: move or remove its dishes first. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const c = deleting;
            setDeleting(null);
            void run(() => scoped.del(`/menu/categories/${c.id}`), `“${c.name}” deleted`);
          }}
        />
      )}
      {gstFor && (
        <CategoryGstDialog
          category={gstFor}
          dishCount={dishesIn(gstFor)}
          onClose={() => setGstFor(null)}
          onSave={async (bps) => {
            await scoped.patch(`/menu/categories/${gstFor.id}`, { taxRateBps: bps });
            await refresh();
            toast.success(`${bps === 0 ? 'No GST' : `GST ${bpsToPercent(bps)}%`} set for ${gstFor.name}`);
          }}
        />
      )}
    </SidePanel>
  );
}

// ---------------- Page body (shared with the Super Admin) ----------------

export function MenuManager({
  scope,
  headerExtra,
  initialEditId,
  onInitialEditOpened,
  taxSettings,
}: {
  scope: MenuScope;
  headerExtra?: React.ReactNode;
  /** Opens this item's edit panel once the menu has loaded (e.g. from the all-restaurants view). */
  initialEditId?: string | null;
  onInitialEditOpened?: () => void;
  /** The restaurant's taxes: new items start at this GST %, older items show what they pay. */
  taxSettings?: TaxSettings;
}) {
  const search = usePageSearch('Search food items...');
  const queryClient = useQueryClient();
  const scoped = useScopedApi(scope);
  const toast = useToast();
  const categories = useCategories(scope, true);
  const items = useMenuItems(scope);
  const [category, setCategory] = useState('all');
  const [panel, setPanel] = useState<{ kind: 'item'; item: MenuItemDTO | null } | { kind: 'categories' } | null>(null);
  useEffect(() => {
    const target = initialEditId ? items.data?.find((i) => i.id === initialEditId) : undefined;
    if (!target) return;
    setPanel({ kind: 'item', item: target });
    onInitialEditOpened?.();
  }, [initialEditId, items.data, onInitialEditOpened]);
  const [archiving, setArchiving] = useState<MenuItemDTO | null>(null);

  const activeCategories = (categories.data ?? []).filter((c) => c.status === 'ACTIVE');
  // The chosen tab's category was deleted or hidden: back to All.
  useEffect(() => {
    if (category !== 'all' && categories.data && !categories.data.some((c) => c.id === category && c.status === 'ACTIVE')) setCategory('all');
  }, [category, categories.data]);
  // Billing only lists dishes whose category is switched on; flag the rest here.
  const activeCategoryIds = new Set(activeCategories.map((c) => c.id));
  const notInBilling = (item: MenuItemDTO) => categories.isSuccess && !activeCategoryIds.has(item.categoryId);
  const categoryIcon = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.icon])), [categories.data]);
  const { dishes, variantsOf } = useMemo(() => groupVariants(items.data ?? []), [items.data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dishes.filter(
      (i) => i.status === 'ACTIVE' && (category === 'all' || i.categoryId === category) && (!q || i.name.toLowerCase().includes(q)),
    );
  }, [dishes, category, search]);
  const hiddenCount = dishes.filter((i) => i.status === 'ACTIVE' && notInBilling(i)).length;

  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: menuKeys.all });
      toast.success(success);
    } catch (err) {
      toast.error(err);
    }
  };

  /** Shows the new order at once, then saves it (New Bill follows the same order). */
  const saveOrder = async (key: readonly unknown[], path: string, ids: string[], apply: (old: never[]) => unknown[]) => {
    queryClient.setQueryData(key, (old: never[] | undefined) => old && apply(old));
    try {
      await scoped.post(path, { ids });
    } catch (err) {
      toast.error(err);
    } finally {
      await queryClient.invalidateQueries({ queryKey: menuKeys.all });
    }
  };
  const reorderDishes = (shown: string[]) => {
    const ids = mergeOrder(
      dishes.map((d) => d.id),
      shown,
    );
    void saveOrder(menuKeys.items(scope), '/menu/items/reorder', ids, (old: MenuItemDTO[]) => byOrder(old, ids));
  };
  const reorderCategories = (shown: string[]) => {
    const ids = mergeOrder(
      (categories.data ?? []).filter((c) => c.editable).map((c) => c.id),
      shown,
    );
    void saveOrder(menuKeys.categories(scope, true), '/menu/categories/reorder', ids, (old: CategoryDTO[]) => byOrder(old, ids));
  };

  return (
    <>
      <div className="page">
        <PageHeader
          title="Menu"
          subtitle="Manage your food items, prices and categories"
          actions={
            <>
              {headerExtra}
              <button className="btn btn-outline btn-lg" onClick={() => setPanel({ kind: 'categories' })}>
                <Layers /> Categories
              </button>
              <button className="btn btn-primary btn-lg" onClick={() => setPanel({ kind: 'item', item: null })}>
                <CirclePlus /> Add Item
              </button>
            </>
          }
        />
        <div className="chips" role="tablist" aria-label="Categories">
          <button className={cx('chip', category === 'all' && 'active')} onClick={() => setCategory('all')}>
            <LayoutGrid /> All
          </button>
          <SortableList ids={activeCategories.map((c) => c.id)} onReorder={reorderCategories} layout="row">
            {activeCategories.map((c) => (
              <SortableItem as="button" key={c.id} id={c.id} className={cx('chip', category === c.id && 'active')} onClick={() => setCategory(c.id)}>
                {c.icon && <span className="chip-icon">{c.icon}</span>}
                {c.name}
              </SortableItem>
            ))}
          </SortableList>
        </div>
        {visible.length > 1 && <div className="muted drag-hint">Press and hold a dish or category, then drag it to a new place.</div>}

        {hiddenCount > 0 && (
          <div className="alert alert-warning" style={{ marginBottom: 14, alignItems: 'center' }}>
            <TriangleAlert />
            <span style={{ flex: 1 }}>
              <strong>{hiddenCount === 1 ? '1 dish is' : `${hiddenCount} dishes are`} not shown in billing</strong> because the category is switched
              off. Turn it on in Categories.
            </span>
            <button className="btn btn-outline btn-sm" onClick={() => setPanel({ kind: 'categories' })}>
              <Layers /> Categories
            </button>
          </div>
        )}
        {items.isLoading || categories.isLoading ? (
          <Loading label="Loading menu…" />
        ) : visible.length === 0 ? (
          <Empty icon={<UtensilsCrossed />} title={search ? 'No items match your search' : 'No food items yet'}>
            {!search && (
              <button className="btn btn-primary" onClick={() => setPanel({ kind: 'item', item: null })}>
                <CirclePlus /> Add your first item
              </button>
            )}
          </Empty>
        ) : (
          <div className="menu-grid">
            <SortableList ids={visible.map((i) => i.id)} onReorder={reorderDishes}>
              {visible.map((item) => (
                <SortableItem key={item.id} id={item.id} className={cx('menu-card', !item.isAvailable && 'unavailable')}>
                  <div className="food-media">
                    <FoodImage src={item.imageUrl} alt={item.name} emoji={categoryIcon.get(item.categoryId)} />
                  </div>
                  <div className="menu-card-tags">
                    {notInBilling(item) && <span className="tag yellow">Not in billing</span>}
                    {!item.isAvailable && <span className="tag dark">Sold out</span>}
                  </div>
                  {scope.branchId && (
                    <button
                      type="button"
                      className={cx('pin-btn', item.pinned && 'pinned')}
                      onClick={() =>
                        void run(
                          () => scoped.patch(`/menu/items/${item.id}/pin`, { pinned: !item.pinned }),
                          item.pinned ? `“${item.name}” unpinned` : `“${item.name}” pinned to the top`,
                        )
                      }
                      aria-pressed={item.pinned}
                      aria-label={item.pinned ? `Unpin ${item.name}` : `Pin ${item.name} to the top`}
                      title={item.pinned ? 'Unpin' : 'Pin to the top'}
                    >
                      {item.pinned ? <PinOff /> : <Pin />}
                    </button>
                  )}
                  <div className="menu-card-body">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="food-name" title={item.name}>
                        {item.name}
                      </div>
                      <div className="food-price">{priceLabel(item, variantsOf.get(item.id))}</div>
                      {variantsOf.get(item.id) && (
                        <div className="menu-card-variants" title={variantsOf.get(item.id)!.map((v) => `${v.variantName} ${formatMoney(v.price)}`).join(' · ')}>
                          {variantsOf.get(item.id)!.map((v) => v.variantName).join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="menu-card-actions">
                    <button className="btn btn-soft btn-sm" onClick={() => setPanel({ kind: 'item', item })} aria-label={`Edit ${item.name}`}>
                      <Pencil /> Edit
                    </button>
                    {item.editable && (
                      <button className="btn btn-danger-soft btn-sm" onClick={() => setArchiving(item)} aria-label={`Remove ${item.name}`}>
                        <Trash2 /> Remove
                      </button>
                    )}
                  </div>
                </SortableItem>
              ))}
            </SortableList>
          </div>
        )}
      </div>

      {panel?.kind === 'item' && (
        <ItemPanel
          key={panel.item?.id ?? 'new'}
          scope={scope}
          item={panel.item}
          variants={panel.item ? (variantsOf.get(panel.item.id) ?? []) : []}
          categories={categories.data ?? []}
          taxSettings={taxSettings ?? { taxes: [], pricesIncludeTax: false }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'categories' && <CategoriesPanel scope={scope} onClose={() => setPanel(null)} />}
      {archiving && (
        <ConfirmDialog
          title={`Remove “${archiving.name}”?`}
          message="This food disappears from the menu and billing. Past bills still show it."
          confirmLabel="Remove"
          danger
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            const it = archiving;
            setArchiving(null);
            void run(() => scoped.post(`/menu/items/${it.id}/archive`), `“${it.name}” removed`);
          }}
        />
      )}
    </>
  );
}

export function MenuPage() {
  const { activeBranch } = useAuth();
  return <MenuManager scope={{ branchId: activeBranch!.id }} taxSettings={activeBranch!.restaurant.settings} />;
}
