import type { Metadata } from 'next';
import type { DocPage } from './pages';

/** Link-preview card for X, LinkedIn, Slack and other unfurlers. */
const card = {
  url: '/assets/social/docs-og.png',
  width: 1200,
  height: 630,
  alt: 'Relate docs: a business graph, defined in TypeScript.',
};

/** Title, description and link-preview tags for one docs page. */
export function pageMetadata(page: DocPage): Metadata {
  const title = `${page.title} | Relate`;
  const { description } = page;

  return {
    title,
    description,
    openGraph: {
      type: 'website',
      siteName: 'Relate',
      url: `/${page.slug.join('/')}`,
      title,
      description,
      images: [card],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [card],
    },
  };
}
