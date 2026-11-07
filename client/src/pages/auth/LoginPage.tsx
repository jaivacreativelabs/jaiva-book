import { APP_NAME, type DemoAccountDTO } from '@rb/shared';
import { useQuery } from '@tanstack/react-query';
import { ChefHat, ConciergeBell, LogIn, Mail, Lock, ShieldCheck, Store, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Field, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../services/api';
import { useAuth } from '../../store/auth';
import { homeFor } from '../../utils/roles';

export function LoginPage() {
  const { user, login, demoLogin, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Demo buttons are configured by the Super Admin and stored in MongoDB.
  const demos = useQuery({
    queryKey: ['demo-accounts'],
    queryFn: () => api.get<DemoAccountDTO[]>('/auth/demo-accounts', { branchId: null }),
    staleTime: 0,
    retry: false,
  });

  if (!loading && user) return <Navigate to={homeFor(user.role)} replace />;

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      void demos.refetch(); // a button may have been switched off meanwhile
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run('form', () => login(email, password));
  };

  return (
    <div className="login-page">
      <section className="login-brand">
        <img className="login-logo" src="/lemon-tree-logo.png" alt="Lemon Tree" />
        <h2>{APP_NAME}</h2>
        <p>Billing, tables, menu and sales for every restaurant – in one place.</p>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <div className="login-mobile-logo">
            <img src="/lemon-tree-logo.png" alt="Lemon Tree" />
            {APP_NAME}
          </div>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Use the account given to you by your administrator.
            </p>
          </div>
          {error && (
            <div className="alert alert-danger" role="alert">
              <TriangleAlert />
              <span>{error}</span>
            </div>
          )}
          <Field label="Email">
            {(id) => (
              <div className="input-icon">
                <Mail />
                <input id={id} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
            )}
          </Field>
          <Field label="Password">
            {(id) => (
              <div className="input-icon">
                <Lock />
                <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            )}
          </Field>
          <button className="btn btn-primary btn-lg" disabled={busy !== null}>
            {busy === 'form' ? <Spinner /> : <LogIn />} Sign in
          </button>
          {(demos.data?.length ?? 0) > 0 && (
            <div className="demo-logins">
              <div className="demo-logins-title">Demo – tap to sign in</div>
              <div className="demo-logins-buttons">
                {demos.data!.map((d) => (
                  <button key={d.id} type="button" className="demo-login" disabled={busy !== null} onClick={() => void run(d.id, () => demoLogin(d.id))}>
                    {busy === d.id ? <Spinner /> : d.role === 'SUPER_ADMIN' ? <ShieldCheck /> : d.role === 'KITCHEN' ? <ChefHat /> : d.role === 'WAITER' ? <ConciergeBell /> : <Store />}
                    <span>
                      <strong>{d.label}</strong>
                      <small>{d.hint}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
