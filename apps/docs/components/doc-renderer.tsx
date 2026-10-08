import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCompiler } from '@fumadocs/mdx-remote';
import { DocsBody, DocsPage } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import rehypeRaw from 'rehype-raw';
import { type DocPage, pageFile, urlForFile } from '../lib/pages';

const compiler = createCompiler({
  format: 'md',
  remarkImageOptions: false,
  remarkNpmOptions: false,
  rehypePlugins: (plugins) => [rehypeRaw, ...plugins],
});

const contentDirectory = 'apps/docs/content';
const repositoryBlob = 'https://github.com/relatehq/relate/blob/main/';

// Relative links resolve from the content file, as they do on GitHub. Links to
// other content pages become site routes; anything else opens on GitHub.
function resolveLink(href: string | undefined, file: string) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;

  const [target = '', hash] = href.split('#', 2);
  const fromRoot = path.posix.normalize(
    path.posix.join(contentDirectory, path.posix.dirname(file), target),
  );
  const fragment = hash ? `#${hash}` : '';

  if (fromRoot.startsWith(`${contentDirectory}/`)) {
    const route = urlForFile(fromRoot.slice(contentDirectory.length + 1));

    if (route) return route + fragment;
  }

  return new URL(fromRoot, repositoryBlob).href + fragment;
}

export async function RenderDoc({ page }: { page: DocPage }) {
  const file = pageFile(page);
  const source = await readFile(
    path.resolve(process.cwd(), 'content', file),
    'utf8',
  );
  const { body: Content, toc } = await compiler.compile({ source });

  return (
    <DocsPage toc={toc.filter((item) => item.depth > 1)}>
      <DocsBody>
        <Content
          components={{
            ...defaultMdxComponents,
            a: ({ href, ...props }) => (
              <defaultMdxComponents.a
                href={resolveLink(href, file)}
                {...props}
              />
            ),
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}
