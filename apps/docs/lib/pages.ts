export interface DocPage {
  /** Route segments; empty for the home page. */
  readonly slug: readonly string[];
  /** Sidebar label. */
  readonly name: string;
  /** Page title and description used in metadata. */
  readonly title: string;
  readonly description: string;
  /** Sidebar section; omitted for top-level pages. */
  readonly section?: string;
}

export const pages: readonly DocPage[] = [
  {
    slug: [],
    name: 'Getting Started',
    title: 'Getting Started',
    description:
      'Define a source, an object, and access rules, then read the graph.',
  },
  {
    slug: ['overview'],
    name: 'Architecture Overview',
    title: 'Architecture Overview',
    description:
      'How Relate handles source ownership, identity, access, and evidence.',
  },
  {
    slug: ['authoring', 'graph'],
    name: 'Graph Modeling',
    title: 'Graph Modeling',
    description: 'Sources, objects, properties, and relationships.',
    section: 'Authoring',
  },
  {
    slug: ['authoring', 'access-control'],
    name: 'Access Control',
    title: 'Access Control & Security',
    description: 'Role gates, claim predicates, and field groups.',
    section: 'Authoring',
  },
  {
    slug: ['runtime', 'reading-data'],
    name: 'Reading Data',
    title: 'Querying & Traversal',
    description: 'Reading objects, traversing relationships, and evidence.',
    section: 'Runtime',
  },
  {
    slug: ['runtime', 'actions'],
    name: 'Actions',
    title: 'Actions, Mutations & Receipts',
    description: 'Native actions, declared failures, and receipts.',
    section: 'Runtime',
  },
  {
    slug: ['deployment', 'postgres'],
    name: 'Postgres Persistence',
    title: 'Postgres Persistence',
    description: 'Persisting the graph in Postgres.',
    section: 'Deployment',
  },
];

export function pageUrl(page: DocPage) {
  return `/${page.slug.join('/')}`;
}

/** Content file for a page, relative to `content/`. */
export function pageFile(page: DocPage) {
  return page.slug.length === 0 ? 'index.md' : `${page.slug.join('/')}.md`;
}

export function findPage(slug: readonly string[] = []) {
  const key = slug.join('/');

  return pages.find((page) => page.slug.join('/') === key);
}

/** Maps a content file (relative to `content/`) back to its page URL. */
export function urlForFile(file: string) {
  const page = pages.find((candidate) => pageFile(candidate) === file);

  return page && pageUrl(page);
}

type TreeNode =
  | { type: 'page'; name: string; url: string }
  | { type: 'separator'; name: string };

export const navigationTree = {
  name: 'Relate',
  children: pages.flatMap((page, index): TreeNode[] => {
    const node: TreeNode = {
      type: 'page',
      name: page.name,
      url: pageUrl(page),
    };

    return page.section && page.section !== pages[index - 1]?.section
      ? [{ type: 'separator', name: page.section }, node]
      : [node];
  }),
};
