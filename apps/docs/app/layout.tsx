import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Logo } from '../components/logo';
import './global.css';

export const metadata: Metadata = {
  title: 'Relate',
  description: 'A semantic business graph, defined in TypeScript.',
  icons: { icon: '/assets/brand/favicon.svg' },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>
          <DocsLayout
            nav={{ title: <Logo />, url: '/' }}
            githubUrl="https://github.com/relatehq/relate"
            searchToggle={{ enabled: false }}
            tree={{
              name: 'Relate',
              children: [{ type: 'page', name: 'Overview', url: '/' }],
            }}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
