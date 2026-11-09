/**
 * Top bar: a chime for food, on every page of the dashboard, with its Sound on / off button.
 * - Kitchen: a new order arrives (a counter's login hears only its own orders).
 * - Waiter: the kitchen marked a table's food Ready.
 * - Restaurant Admin: table food is Ready, or a parcel is ready to hand over.
 * - Kitchen and Restaurant Admin also hear a softer sound when Ready food is served at a table or
 *   a parcel is handed over – unless they did it on this screen.
 * Kitchen and Waiter also get a popup with the dishes (FoodNotices), even with the sound off.
 * Only for branches with the Kitchen Display. The queries share their keys with the Kitchen,
 * Waiter and New Bill pages, so no request is made twice.
 */
import type { KitchenTicketDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FoodNotices, NOTICE_MS, type Notice } from './FoodNotices';
import { useOrderChime } from '../hooks/useOrderChime';
import { api } from '../services/api';
import { useAuth } from '../store/auth';
import { cx } from '../utils/format';

// Every 3 s – and right away when the screen comes back to the front (see below).
const POLL = {
  refetchInterval: 3_000,
  refetchIntervalInBackground: true,
  staleTime: 0,
} as const;

export function FoodAlerts() {
  const { user, activeBranch } = useAuth();
  const role = user?.role;
  const branchId = activeBranch?.id ?? '';
  const on = Boolean(activeBranch?.kitchenDisplay) && (role === 'KITCHEN' || role === 'WAITER' || role === 'RESTAURANT_ADMIN');

  const kitchen = useQuery({
    queryKey: ['kitchen', branchId],
    queryFn: () => api.get<KitchenTicketDTO[]>('/kitchen/tickets'),
    enabled: on && role === 'KITCHEN',
    ...POLL,
  });
  const ready = useQuery({
    queryKey: ['waiter', branchId],
    queryFn: () => api.get<KitchenTicketDTO[]>('/waiter/tickets'),
    enabled: on && (role === 'WAITER' || role === 'RESTAURANT_ADMIN'),
    ...POLL,
  });
  const parcels = useQuery({
    queryKey: ['parcels', branchId],
    queryFn: () => api.get<KitchenTicketDTO[]>('/kitchen/parcels'),
    enabled: on && role === 'RESTAURANT_ADMIN',
    ...POLL,
  });

  // Keep the alerts on time when this screen is not in front: browsers slow a background tab's
  // timers to about once a minute, but not a worker's. Back in front: check straight away.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!on) return;
    const keys = role === 'KITCHEN' ? ['kitchen'] : role === 'WAITER' ? ['waiter'] : ['waiter', 'parcels'];
    const refresh = () => keys.forEach((k) => void queryClient.refetchQueries({ queryKey: [k, branchId], type: 'active' }));
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../hooks/tick.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = () => document.hidden && refresh();
    } catch {
      // No workers here: the normal 3 s check still runs.
    }
    const onShow = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      worker?.terminate();
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [on, role, branchId, queryClient]);

  const ids = useMemo(() => {
    if (role === 'KITCHEN') return kitchen.data?.filter((t) => t.status === 'NEW').map((t) => t.id);
    if (role === 'WAITER') return ready.data?.map((t) => t.id);
    if (!ready.data || !parcels.data) return undefined; // wait for both, or the first load would chime
    return [...ready.data, ...parcels.data].map((t) => t.id);
  }, [role, kitchen.data, ready.data, parcels.data]);

  // Ready food on screen: when one leaves it, it was served / handed over (Kitchen and Admin hear it).
  const readyIds = useMemo(() => {
    if (role === 'KITCHEN') return kitchen.data?.filter((t) => t.status === 'READY').map((t) => t.id);
    if (role === 'RESTAURANT_ADMIN') return ids;
    return undefined;
  }, [role, kitchen.data, ids]);

  // Popups: Kitchen for new orders, Waiter for Ready food.
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeSeq = useRef(0);
  const timers = useRef(new Map<number, number>());
  const close = useCallback((key: number) => {
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setNotices((list) => list.filter((n) => n.key !== key));
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, []);
  const onArrive = useCallback(
    (fresh: string[]) => {
      if (role !== 'KITCHEN' && role !== 'WAITER') return;
      const source = role === 'KITCHEN' ? kitchen.data : ready.data;
      const added = fresh.flatMap((id) => {
        const ticket = source?.find((t) => t.id === id);
        return ticket
          ? [
              {
                key: ++noticeSeq.current,
                kind: role === 'KITCHEN' ? ('order' as const) : ('ready' as const),
                ticket,
              },
            ]
          : [];
      });
      if (!added.length) return;
      for (const n of added)
        timers.current.set(
          n.key,
          window.setTimeout(() => close(n.key), NOTICE_MS),
        );
      setNotices((list) => {
        const next = [...list, ...added];
        next.slice(0, -4).forEach((n) => window.clearTimeout(timers.current.get(n.key)));
        return next.slice(-4);
      });
    },
    [role, kitchen.data, ready.data, close],
  );

  const sound = useOrderChime(on ? ids : undefined, `${user?.id}:${branchId}`, on ? readyIds : undefined, onArrive);
  if (!on) return null;

  const what = role === 'KITCHEN' ? 'a new order arrives' : role === 'WAITER' ? 'food is ready' : 'food or a parcel is ready';
  // Two states only: on or off.
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={sound.enabled}
        className={cx('sound-switch', sound.enabled && 'on')}
        onClick={sound.press}
        title={sound.enabled ? `Sound on: a sound plays when ${what} – tap to turn off` : `Sound off: no sound when ${what} – tap to turn on`}
      >
        {sound.enabled ? <Volume2 size={17} /> : <VolumeX size={17} />}
        <span className="sound-text">{sound.enabled ? 'Sound on' : 'Sound off'}</span>
        <span className="sound-track" aria-hidden />
      </button>
      <FoodNotices notices={notices} onClose={close} />
    </>
  );
}
