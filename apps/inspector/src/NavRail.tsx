import { Link, useRouterState } from '@tanstack/react-router';
import { Icon } from './icons.js';
import type { IconName } from './icons.js';

export type InspectorPage = {
  readonly path: '/' | '/objects' | '/sources' | '/policies' | '/activity';
  readonly label: string;
  readonly icon: IconName;
};

/** Every inspector screen, in rail order. Only the graph is built so far. */
export const inspectorPages: readonly InspectorPage[] = [
  { path: '/', label: 'Graph', icon: 'sitemap' },
  { path: '/objects', label: 'Objects', icon: 'cube' },
  { path: '/sources', label: 'Sources', icon: 'database' },
  { path: '/policies', label: 'Policies', icon: 'shield' },
  { path: '/activity', label: 'Activity', icon: 'history' },
];

/** The page whose route is currently matched, if any. */
export function useActivePage(): InspectorPage | undefined {
  const routeId = useRouterState({ select: (s) => s.matches.at(-1)?.routeId });

  return inspectorPages.find((page) => page.path === routeId);
}

/** The 48px left rail: the Relate mark and one icon button per page. */
export function NavRail() {
  return (
    <nav className="nav-rail" aria-label="Inspector pages">
      <div className="nav-rail-mark" aria-hidden="true">
        <span>R</span>
      </div>
      {inspectorPages.map((page) => (
        <Link
          key={page.path}
          to={page.path}
          className="icon-button nav-rail-item"
          activeOptions={{ exact: true }}
          activeProps={{ className: 'active', 'aria-current': 'page' }}
          aria-label={page.label}
          data-tooltip={page.label}
        >
          <Icon name={page.icon} size={16} />
        </Link>
      ))}
    </nav>
  );
}

/** Stand-in for a page that is in the rail but not built yet. */
export function PlaceholderScreen(props: { readonly label: string }) {
  return (
    <div className="placeholder-screen">
      <div className="title">{props.label}</div>
      <div className="hint">Not available yet</div>
    </div>
  );
}
