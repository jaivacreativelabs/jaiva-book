import { useSearchParams } from 'react-router-dom';
import { ServedView } from '../restaurant/ServedPage';
import { ScopeSelect, useAllBranches } from './adminShared';

/** Super Admin: served orders of any restaurant (and location, for one with several). */
export function AdminServedPage() {
  const [params, setParams] = useSearchParams();
  const restaurantId = params.get('restaurantId') ?? '';
  const chosen = params.get('branchId') ?? '';
  const branches = (useAllBranches().data ?? []).filter((b) => b.restaurantId === restaurantId);
  const branchId = chosen || (branches.length === 1 ? branches[0].id : null);
  return (
    <ServedView
      branchId={branchId}
      filters={
        <ScopeSelect
          restaurantId={restaurantId}
          branchId={chosen}
          requireRestaurant
          allBranchesLabel="Select location"
          onChange={(next) => {
            const p = new URLSearchParams();
            if (next.restaurantId) p.set('restaurantId', next.restaurantId);
            if (next.branchId) p.set('branchId', next.branchId);
            setParams(p, { replace: true });
          }}
        />
      }
    />
  );
}
