import { renderMermaidSVG } from 'beautiful-mermaid';

export function Mermaid({ chart }: { chart: string }) {
  const svg = renderMermaidSVG(chart, {
    bg: 'var(--color-fd-background)',
    fg: 'var(--color-fd-foreground)',
    transparent: true,
  });

  return (
    <figure className="my-6">
      <div
        className="overflow-x-auto rounded-lg border p-4 [&_svg]:mx-auto"
        role="img"
        aria-label="Documentation diagram; text description follows"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <details className="mt-2 text-sm text-fd-muted-foreground">
        <summary className="cursor-pointer">Diagram source</summary>
        <pre className="overflow-x-auto">
          <code>{chart}</code>
        </pre>
      </details>
    </figure>
  );
}
