import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { SessionProvider, useSession } from './store/session.js';
import { AppShell } from './components/AppShell.js';
import { Login } from './routes/Login.js';
import { Browse } from './routes/Browse.js';
import { Opportunity } from './routes/Opportunity.js';
import { Calendar } from './routes/Calendar.js';
import { Watchlist } from './routes/Watchlist.js';
import { Inbox } from './routes/Inbox.js';
import { Profile } from './routes/Profile.js';
import { Sources } from './routes/Sources.js';
import { Admin } from './routes/Admin.js';
import { TemplatesScreen } from './routes/Templates.js';

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
        {/*
          Task 18's ineligibility explorer has no route of its own — it renders
          inside Browse, which is why there is no `/why` here.
        */}
        <Route path="/" element={<Browse />} />
        <Route path="/o/:programId" element={<Opportunity />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/watchlist" element={<Watchlist />} />
        {/*
          The writing desk. `TemplatesScreen` is the query-string-aware wrapper; `TemplatesRoute`
          stays prop-driven so component tests can render it without a router.

          THE SECOND HALF OF THIS PAIR IS MISSING ON PURPOSE, AND IT IS NOT OPTIONAL.
          `AppShell`'s rail links to `/applications` and the opportunity screen deep-links to it,
          but `routes/Applications.tsx` is created by Plan 4 Task 19 — importing it here before it
          exists fails to resolve and takes the whole web suite down, so the line below cannot be
          written yet:

            <Route path="/applications" element={<ApplicationsScreen />} />

          Task 19 adds it, with the matching import. Until then `/applications` renders NotFound,
          and `routes/Templates.test.tsx` ("every rail entry has a route") holds it in a
          self-cleaning PENDING list: the day the route lands, that test says so and the exemption
          has to be deleted. A rail entry with no route is a working link to a wrong-address page,
          which no test of either file alone can see.
        */}
        <Route path="/templates" element={<TemplatesScreen />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/profile" element={<Profile />} />
        {/*
          `AdminOnly` is a client-side courtesy so the rail does not lead a member
          somewhere they will be refused. `requireAdmin` on the server is the real
          guard, and the Inbox deliberately has no wrapper here: members may READ
          the queue, and `canDecide` from the API gates the controls instead.
        */}
        <Route
          path="/admin"
          element={
            <AdminOnly>
              <Admin />
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
