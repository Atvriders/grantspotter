import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { SessionProvider, useSession } from './store/session.js';
import { AppShell } from './components/AppShell.js';
import { SignedOut } from './routes/FirstRun.js';
import { Browse } from './routes/Browse.js';
import { Opportunity } from './routes/Opportunity.js';
import { Calendar } from './routes/Calendar.js';
import { ExportsRoute } from './routes/Exports.js';
import { Watchlist } from './routes/Watchlist.js';
import { Inbox } from './routes/Inbox.js';
import { Profile } from './routes/Profile.js';
import { Sources } from './routes/Sources.js';
import { Admin } from './routes/Admin.js';
import { TemplatesScreen } from './routes/Templates.js';
import { ApplicationsScreen } from './routes/Applications.js';

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
  /*
    Not `<Login>` directly. On a fresh install there is no account to sign in to, and this
    line handed the operator a sign-in form for one anyway — the only way past it was a
    hand-written curl to `POST /api/auth/bootstrap`. `SignedOut` asks the server which of
    the two screens is true first. `refresh` is passed through unchanged: bootstrap opens a
    session exactly as login does, so creating the first administrator lands them in the
    same place a sign-in does.
  */
  if (!user) return <SignedOut onAuthenticated={refresh} />;

  return (
    <AppShell>
      <Routes>
        {/*
          Task 18's ineligibility explorer has no route of its own — it renders
          inside Browse, which is why there is no `/why` here.
        */}
        <Route path="/" element={<Browse />} />
        {/*
          `/browse` is an ALIAS for `/`, not a second screen.

          The rail's "Browse" entry points at `/`, so nothing in the app ever linked here — but
          `/browse` is the address a user types, bookmarks or is sent by a colleague, and it is the
          worked example three places in the ship plan use for "a deep client route survives a hard
          refresh". Without this line all four of those were true only at the HTTP layer: the server
          hands back the SPA shell for any GET (`api/spa.ts`), so `curl -o /dev/null -w '%{http_code}'
          /browse` prints 200 and looks right, while the screen underneath renders `NotFound`. A
          status check that passes over a wrong-address page is worse than one that fails.

          `replace` so the Back button returns to wherever the user came from rather than to the
          alias, which would bounce them straight forward again.
        */}
        <Route path="/browse" element={<Navigate to="/" replace />} />
        <Route path="/o/:programId" element={<Opportunity />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/exports" element={<ExportsRoute />} />
        <Route path="/watchlist" element={<Watchlist />} />
        {/*
          The writing desk. The `*Screen` wrappers are the query-string-aware versions;
          `TemplatesRoute` and `ApplicationsRoute` stay prop-driven so component tests can render
          them without a router.

          Both halves are here now. Until Task 19 created `routes/Applications.tsx` the second line
          could not be written — importing a module that does not exist fails to resolve and takes
          the whole web suite down — so the rail linked to `/applications` while the path rendered
          NotFound, and `routes/Templates.test.tsx` ("every rail entry has a route") held it in a
          self-cleaning PENDING list. That list is now empty, and the first assertion covers this
          path from here on: a rail entry with no route is a working link to a wrong-address page,
          which no component test of either file alone can see.
        */}
        <Route path="/templates" element={<TemplatesScreen />} />
        <Route path="/applications" element={<ApplicationsScreen />} />
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
