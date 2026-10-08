interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  name?: string;
  attributes?: { type: 'mdxJsxAttribute'; name: string; value: string }[];
}

const alertTypes: Record<string, string> = {
  NOTE: 'info',
  TIP: 'success',
  IMPORTANT: 'info',
  WARNING: 'warning',
  CAUTION: 'error',
};

// Preserve GitHub-compatible source while rendering alerts as native callouts.
export function remarkAlerts() {
  return function transform(node: MarkdownNode) {
    if (node.type === 'blockquote') {
      const paragraph = node.children?.[0];
      const marker = paragraph?.children?.[0];
      const match =
        marker?.type === 'text'
          ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(
              marker.value ?? '',
            )
          : null;

      if (paragraph?.type === 'paragraph' && marker && match) {
        marker.value = marker.value!.slice(match[0].length);
        if (!marker.value) paragraph.children!.shift();
        if (!paragraph.children!.length) node.children!.shift();
        node.type = 'mdxJsxFlowElement';
        node.name = 'Callout';
        node.attributes = [
          {
            type: 'mdxJsxAttribute',
            name: 'type',
            value: alertTypes[match[1]!]!,
          },
          {
            type: 'mdxJsxAttribute',
            name: 'title',
            value: match[1]![0] + match[1]!.slice(1).toLowerCase(),
          },
        ];
      }
    }

    node.children?.forEach(transform);
  };
}
