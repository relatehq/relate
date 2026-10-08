import type { ReactNode } from 'react';

export type TagColor =
  'blue' | 'jade' | 'purple' | 'red' | 'orange' | 'amber' | 'gray';

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
      className={`tag tag-${variant} tag-${props.color}${
        props.weight === 'medium' ? ' tag-medium' : ''
      }`}
      title={props.title}
    >
      {props.children}
    </span>
  );
}

export function Status(props: {
  readonly color: 'green' | 'orange' | 'gray' | 'red';
  readonly children: ReactNode;
}) {
  return (
    <span className={`status status-${props.color}`} role="status">
      {props.children}
    </span>
  );
}

export function Callout(props: {
  readonly variant: 'warning' | 'info' | 'danger';
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  const glyph = props.variant === 'info' ? 'i' : '!';

  return (
    <div className={`callout callout-${props.variant}`} role="alert">
      <span className="callout-icon" aria-hidden="true">
        {glyph}
      </span>
      <div className="callout-body">
        <span className="callout-title">{props.title}</span>
        <span className="callout-description">{props.description}</span>
      </div>
      {props.action && (
        <button
          type="button"
          className="button button-solid"
          onClick={props.action.onClick}
        >
          {props.action.label}
        </button>
      )}
    </div>
  );
}

export function Button(props: {
  readonly variant?: 'ghost' | 'solid' | 'outline';
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`button button-${props.variant ?? 'ghost'}`}
      title={props.title}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
