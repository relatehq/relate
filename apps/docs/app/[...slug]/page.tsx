import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RenderDoc } from '../../components/doc-renderer';
import { pageMetadata } from '../../lib/metadata';
import { findPage, pages } from '../../lib/pages';

export const dynamicParams = false;

export function generateStaticParams() {
  return pages
    .filter((page) => page.slug.length > 0)
    .map((page) => ({ slug: [...page.slug] }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const page = findPage((await params).slug);

  if (!page) return {};

  return pageMetadata(page);
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const page = findPage((await params).slug);

  if (!page) notFound();

  return <RenderDoc page={page} />;
}
