import type { Metadata } from 'next';
import { RenderDoc } from '../components/doc-renderer';
import { findPage } from '../lib/pages';

const page = findPage()!;

export const metadata: Metadata = {
  title: `${page.title} | Relate`,
  description: page.description,
};

export default function Page() {
  return <RenderDoc page={page} />;
}
