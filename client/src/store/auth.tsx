import type { BranchContextDTO, MeDTO, UserDTO } from '@rb/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setApiBranch, setUnauthorizedHandler } from '../services/api';

interface AuthState {
  user: UserDTO | null;
  branches: BranchContextDTO[];
  activeBranch: BranchContextDTO | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** One-tap sign-in with a demo account enabled by the Super Admin. */
  demoLogin: (userId: string) => Promise<void>;
  /** false when the server could not be reached: the session is still there, nothing was cleared */
  logout: () => Promise<boolean>;
  refresh: () => Promise<void>;
  selectBranch: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);
const branchKey = (userId: string) => `rb.branch.${userId}`;

function readStoredBranch(userId: string): string | null {
  try {
    return localStorage.getItem(branchKey(userId));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<MeDTO | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((data: MeDTO | null) => {
    setMe(data);
    if (!data) {
      setBranchId(null);
      setApiBranch(null);
      return;
    }
    const stored = readStoredBranch(data.user.id);
    const chosen = data.branches.find((b) => b.id === stored)?.id ?? data.branches[0]?.id ?? null;
    setBranchId(chosen);
    setApiBranch(chosen);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.get<MeDTO>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) apply(null);
      else throw err;
    }
  }, [apply]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      apply(null);
      queryClient.clear();
    });
    refresh()
      .catch(() => apply(null))
      .finally(() => setLoading(false));
  }, [apply, refresh, queryClient]);

  const value = useMemo<AuthState>(() => {
    const activeBranch = me?.branches.find((b) => b.id === branchId) ?? null;
    return {
      user: me?.user ?? null,
      branches: me?.branches ?? [],
      activeBranch,
      loading,
      login: async (email, password) => {
        queryClient.clear();
        apply(await api.post<MeDTO>('/auth/login', { email, password }));
      },
      demoLogin: async (userId) => {
        queryClient.clear();
        apply(await api.post<MeDTO>('/auth/demo-login', { userId }));
      },
      logout: async () => {
        // (api already retries a flaky connection.) Clearing the screen while the session cookie
        // stays would only sign the person back in on the next refresh.
        const ok = await api
          .post('/auth/logout')
          .then(
            () => true,
            () => false,
          );
        if (!ok) return false;
        queryClient.clear();
        apply(null);
        return true;
      },
      refresh,
      selectBranch: (id) => {
        if (!me) return;
        try {
          localStorage.setItem(branchKey(me.user.id), id);
        } catch {
          /* storage unavailable – selection still applies for this tab */
        }
        setBranchId(id);
        setApiBranch(id);
        queryClient.removeQueries();
      },
    };
  }, [me, branchId, loading, apply, refresh, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
