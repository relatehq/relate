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
    name: 'Why Relate',
    title: 'Why Relate',
    description:
      'Why Relate exists: a shared business model across APIs and databases.',
  },
  {
    slug: ['getting-started'],
    name: 'Getting Started',
    title: 'Getting Started',
    description:
      'Define a source, an object, and access rules, then read the graph.',
  },
  {
    slug: ['key-concepts'],
    name: 'Key Concepts',
    title: 'Key Concepts',
    description:
      'The main authoring concepts and how they fit into a running Relate app.',
  },
  {
    slug: ['overview'],
    name: 'Architecture Overview',
    title: 'Architecture Overview',
    description:
      'How compilation, reads, authorization, transactions, and storage fit together.',
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
    slug: ['authoring', 'inspector'],
    name: 'Inspector',
    title: 'Running the Inspector',
    description:
      'Open a live model graph and inspect different Relate projects.',
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
    name: 'Persistence',
    title: 'Persistence',
    description: 'Storage options for runtime state and durable persistence.',
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
