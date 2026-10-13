import type { CSSProperties, ReactNode } from 'react';

export function Status(props: {
  readonly color: 'green' | 'orange' | 'gray' | 'red';
  readonly children: ReactNode;
}) {
  return (
    <span
      className="status"
      style={
        {
          '--tw-status-background': `var(--t-tag-background-${props.color})`,
          '--tw-status-text-color': `var(--t-tag-text-${props.color})`,
        } as CSSProperties
      }
      role="status"
    >
      <span className="status-content">{props.children}</span>
    </span>
  );
}
