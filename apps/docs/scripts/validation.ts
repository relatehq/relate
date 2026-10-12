interface Documentation {
  readonly pages: readonly { readonly file: string; readonly url: string }[];
  readonly contentFiles: readonly string[];
  /** Export-relative HTML filenames and contents. */
  readonly html: ReadonlyMap<string, string>;
  readonly repositoryExists: (path: string) => boolean;
  readonly assetExists: (path: string) => boolean;
}

const origin = 'https://docs.relatehq.dev';
const repository = 'https://github.com/relatehq/relate/blob/main/';

function decodeAttribute(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
  };

  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (all, key: string) => {
      if (!key.startsWith('#')) return named[key.toLowerCase()] ?? all;

      const code =
        key[1]?.toLowerCase() === 'x'
          ? Number.parseInt(key.slice(2), 16)
          : Number.parseInt(key.slice(1), 10);

      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    },
  );
}

function htmlFile(pathname: string): string {
  if (pathname === '/') return 'index.html';

  const relative = pathname.replace(/^\//, '').replace(/\/$/, '');

  return relative.endsWith('.html') ? relative : `${relative}.html`;
}

/** Check rendered HTML so anchors follow the actual Markdown renderer. */
export function validateDocumentation(docs: Documentation): string[] {
  const issues = new Set<string>();
  const files = new Set(docs.contentFiles);
  const registered = new Set<string>();
  const urls = new Set<string>();
  const anchors = new Map<string, Set<string>>();

  for (const page of docs.pages) {
    if (registered.has(page.file))
      issues.add(`Duplicate content registration: ${page.file}`);

    if (urls.has(page.url)) issues.add(`Duplicate route: ${page.url}`);

    if (!files.has(page.file)) issues.add(`Missing content: ${page.file}`);

    if (!docs.html.has(htmlFile(page.url)))
      issues.add(`Missing exported page: ${page.url}`);

    registered.add(page.file);
    urls.add(page.url);
  }

  for (const file of files) {
    if (!registered.has(file)) issues.add(`Unregistered content: ${file}`);
  }

  for (const [file, html] of docs.html) {
    anchors.set(
      file,
      new Set(
        Array.from(html.matchAll(/\sid="([^"]*)"/g), (match) =>
          decodeAttribute(match[1]!),
        ),
      ),
    );
  }

  for (const page of docs.pages) {
    const html = docs.html.get(htmlFile(page.url));

    if (!html) continue;

    // Ignore Next's serialized payload; inspect actual rendered anchors only.
    for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>/g)) {
      const href = decodeAttribute(match[1]!);

      try {
        const url = new URL(href, origin + page.url);

        if (url.href.startsWith(repository)) {
          const target = decodeURIComponent(
            url.pathname.slice('/relatehq/relate/blob/main/'.length),
          );

          if (!docs.repositoryExists(target))
            issues.add(`${page.url}: missing repository target ${href}`);

          continue;
        }

        if (url.origin !== origin) continue;

        const pathname = decodeURIComponent(url.pathname);
        const file = htmlFile(pathname);

        if (!docs.html.has(file)) {
          if (!docs.assetExists(pathname.slice(1)))
            issues.add(`${page.url}: missing target ${href}`);

          continue;
        }

        if (
          url.hash &&
          !anchors.get(file)?.has(decodeURIComponent(url.hash.slice(1)))
        )
          issues.add(`${page.url}: missing anchor ${href}`);
      } catch {
        issues.add(`${page.url}: invalid link ${href}`);
      }
    }
  }

  return [...issues];
}
