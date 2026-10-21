import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { PlaceholderScreen, inspectorPages } from './NavRail.js';
import { ActivityScreen } from './screens/ActivityScreen.js';
import { AgentScreen } from './screens/AgentScreen.js';
import { GraphScreen } from './screens/GraphScreen.js';
import { InspectorShell } from './screens/InspectorShell.js';
import { PlaygroundScreen } from './screens/PlaygroundScreen.js';

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

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  // `?request=<requestId>` opens one call, as linked from the agent page.
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search.request === 'string' ? { request: search.request } : {},
  component: ActivityScreen,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agent',
  component: AgentScreen,
});

const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/playground',
  component: PlaygroundScreen,
});

const builtPaths: ReadonlySet<string> = new Set([
  '/',
  '/activity',
  '/agent',
  '/playground',
]);

// Rail pages without a screen yet render a placeholder so navigation is complete.
const placeholderRoutes = inspectorPages
  .filter((page) => !builtPaths.has(page.path))
  .map((page) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: page.path,
      component: () => <PlaceholderScreen label={page.label} />,
    }),
  );

const routeTree = rootRoute.addChildren([
  graphRoute,
  activityRoute,
  agentRoute,
  playgroundRoute,
  ...placeholderRoutes,
]);

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
