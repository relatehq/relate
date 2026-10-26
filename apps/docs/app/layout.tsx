import type { Metadata } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Logo } from '../components/logo';
import { navigationTree } from '../lib/pages';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.relatehq.dev'),
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
            tree={navigationTree}
          >
            {children}
          </DocsLayout>
        </RootProvider>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-SSXWDQMFLE"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-SSXWDQMFLE', { site_section: 'docs' });
          `}
        </Script>
      </body>
    </html>
  );
}
