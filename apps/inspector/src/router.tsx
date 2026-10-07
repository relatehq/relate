import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
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

const routeTree = rootRoute.addChildren([graphRoute]);

/** One screen today; the router carries the mount path so more can follow. */
export function createInspectorRouter(basepath: string) {
  return createRouter({
    routeTree,
    basepath: basepath || '/',
    defaultNotFoundComponent: () => (
      <div className="notice">
        <h2>Nothing here</h2>
        <p>The model graph is the only screen in this inspector.</p>
      </div>
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createInspectorRouter>;
  }
}
