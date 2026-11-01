/** React Query hooks for server state. Keys include the scope so branches never mix. */
import type { CategoryDTO, MenuItemDTO, TablesResponseDTO } from '@rb/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Menu scope: a branch (header/query) or, for the Super Admin, a whole restaurant. */
export interface MenuScope {
  branchId?: string | null;
  restaurantId?: string | null;
}

export const scopeQuery = (s: MenuScope) => (s.branchId ? { branchId: s.branchId } : { restaurantId: s.restaurantId ?? undefined });
const scopeKey = (s: MenuScope) => s.branchId ?? `r:${s.restaurantId}`;
const scopeReady = (s: MenuScope) => Boolean(s.branchId || s.restaurantId);

export const menuKeys = {
  all: ['menu'] as const,
  categories: (s: MenuScope, includeInactive = false) => ['menu', 'categories', scopeKey(s), includeInactive] as const,
  items: (s: MenuScope, includeArchived = false) => ['menu', 'items', scopeKey(s), includeArchived] as const,
};

export function useCategories(scope: MenuScope, includeInactive = false) {
  return useQuery({
    queryKey: menuKeys.categories(scope, includeInactive),
    queryFn: () =>
      api.get<CategoryDTO[]>('/menu/categories', {
        query: { ...scopeQuery(scope), includeInactive },
        branchId: scope.branchId ?? null,
      }),
    enabled: scopeReady(scope),
  });
}

export function useMenuItems(scope: MenuScope, includeArchived = false) {
  return useQuery({
    queryKey: menuKeys.items(scope, includeArchived),
    queryFn: () =>
      api.get<MenuItemDTO[]>('/menu/items', {
        query: { ...scopeQuery(scope), includeArchived },
        branchId: scope.branchId ?? null,
      }),
    enabled: scopeReady(scope),
  });
}

export const tableKeys = { list: (branchId: string | null) => ['tables', branchId] as const };

export function useTables(branchId: string | null, refetchMs = 15_000) {
  return useQuery({
    queryKey: tableKeys.list(branchId),
    queryFn: () => api.get<TablesResponseDTO>('/tables', { branchId }),
    enabled: Boolean(branchId),
    // Other admins may seat guests or bill tables at the same time.
    refetchInterval: refetchMs,
  });
}
