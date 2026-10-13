import type { CSSProperties, ReactNode } from 'react';

export type TagColor =
  | 'blue'
  | 'jade'
  | 'sky'
  | 'iris'
  | 'gold'
  | 'pink'
  | 'purple'
  | 'red'
  | 'orange'
  | 'amber'
  | 'gray';

export function Tag(props: {
  readonly color: TagColor;
  readonly variant?: 'soft' | 'outline';
  readonly weight?: 'regular' | 'medium';
  readonly title?: string | undefined;
  readonly children: ReactNode;
}) {
  const variant = props.variant ?? 'soft';

  return (
    <span
      className={`tag tag-${variant}${props.weight === 'medium' ? ' tag-medium' : ''}`}
      style={
        {
          '--tw-tag-background': `var(--t-tag-background-${props.color})`,
          '--tw-tag-text': `var(--t-tag-text-${props.color})`,
        } as CSSProperties
      }
      title={props.title}
    >
      <span className="tag-content">{props.children}</span>
    </span>
  );
}
