import type { Metadata } from 'next';
import { RenderDoc } from '../components/doc-renderer';
import { pageMetadata } from '../lib/metadata';
import { findPage } from '../lib/pages';

const page = findPage()!;

export const metadata: Metadata = pageMetadata(page);

export default function Page() {
  return <RenderDoc page={page} />;
}
