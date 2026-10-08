import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCompiler } from '@fumadocs/mdx-remote';
import { DocsBody, DocsPage } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import rehypeRaw from 'rehype-raw';
import { Logo } from '../components/logo';

const compiler = createCompiler({
  format: 'md',
  remarkImageOptions: false,
  remarkNpmOptions: false,
  rehypePlugins: (plugins) => [rehypeRaw, ...plugins],
});

function repositoryLink(href: string | undefined) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;

  return new URL(href, 'https://github.com/relatehq/relate/blob/main/').href;
}

export default async function Page() {
  const source = await readFile(
    path.resolve(process.cwd(), '../../README.md'),
    'utf8',
  );
  const { body: Content, toc } = await compiler.compile({ source });

  return (
    <DocsPage toc={toc}>
      <DocsBody>
        <Content
          components={{
            ...defaultMdxComponents,
            // The README's picture uses OS appearance; follow the app's theme instead.
            picture: () => <Logo height={48} />,
            a: ({ href, ...props }) => (
              <defaultMdxComponents.a href={repositoryLink(href)} {...props} />
            ),
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}
