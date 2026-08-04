import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { SessionProvider, useSession } from './store/session.js';
import { AppShell } from './components/AppShell.js';
import { Login } from './routes/Login.js';

function Placeholder({ title }: { title: string }): JSX.Element {
  return <h1>{title}</h1>;
}

/**
 * An unrecognised path inside the shell would otherwise render an empty `main`,
 * which reads as "there is nothing here" rather than "that address is wrong".
 */
function NotFound(): JSX.Element {
  return (
    <>
      <h1>Not found</h1>
      <p>No GrantSpotter screen answers to that address.</p>
    </>
  );
}

/** Client-side courtesy guard. `requireAdmin` on the server is the real one. */
function AdminOnly({ children }: { children: JSX.Element }): JSX.Element {
  const { user } = useSession();
  return user?.role === 'admin' ? children : <Navigate to="/" replace />;
}

function Authenticated(): JSX.Element {
  const { user, loading, refresh } = useSession();
  if (loading) return <p className="eyebrow">Loading…</p>;
  if (!user) return <Login onAuthenticated={refresh} />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Placeholder title="Browse" />} />
        <Route path="/o/:programId" element={<Placeholder title="Opportunity" />} />
        <Route path="/calendar" element={<Placeholder title="Calendar" />} />
        <Route path="/watchlist" element={<Placeholder title="Watchlist" />} />
        <Route path="/inbox" element={<Placeholder title="Inbox" />} />
        <Route path="/sources" element={<Placeholder title="Sources" />} />
        <Route path="/profile" element={<Placeholder title="Profile" />} />
        <Route
          path="/admin"
          element={
            <AdminOnly>
              <Placeholder title="Admin" />
            </AdminOnly>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Authenticated />
      </SessionProvider>
    </BrowserRouter>
  );
}
