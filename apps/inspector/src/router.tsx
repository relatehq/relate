import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { PlaceholderScreen, inspectorPages } from './NavRail.js';
import { GraphScreen } from './screens/GraphScreen.js';
import { InspectorShell } from './screens/InspectorShell.js';

const rootRoute = createRootRoute({
  component: () => (
    <InspectorShell>
      <Outlet />
    </InspectorShell>
  ),
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: GraphScreen,
});

// Rail pages without a screen yet render a placeholder so navigation is complete.
const placeholderRoutes = inspectorPages
  .filter((page) => page.path !== '/')
  .map((page) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: page.path,
      component: () => <PlaceholderScreen label={page.label} />,
    }),
  );

const routeTree = rootRoute.addChildren([graphRoute, ...placeholderRoutes]);

/**
 * Pages live in the hash (`#/objects`): the server serves the shell only at the
 * mount, and the client derives its dev endpoints from the document path.
 */
export function createInspectorRouter() {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    defaultNotFoundComponent: () => (
      <div className="notice">
        <h2>Nothing here</h2>
        <p>Pick a page from the rail on the left.</p>
      </div>
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createInspectorRouter>;
  }
}
