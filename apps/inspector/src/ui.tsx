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

/** Tabler's `help` outline icon, the design system Callout's default glyph. */
function HelpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
      <path d="M12 17l0 .01" />
      <path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4" />
    </svg>
  );
}

export function Callout(props: {
  readonly variant: 'warning' | 'info' | 'error';
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <div className={`callout callout-${props.variant}`} role="alert">
      <div className="callout-header">
        <span className="callout-icon">
          <HelpIcon />
        </span>
        <span className="callout-title">{props.title}</span>
      </div>
      <div
        className={`callout-description-wrapper${props.action ? ' with-action' : ''}`}
      >
        <span className="callout-description">{props.description}</span>
      </div>
      {props.action && (
        <div className="callout-footer">
          <Button onClick={props.action.onClick}>{props.action.label}</Button>
        </div>
      )}
    </div>
  );
}

export function Button(props: {
  readonly variant?: 'ghost' | 'solid';
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

/** Square ghost button around an icon, with a hover tooltip below it. */
export function IconButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="icon-button icon-button-sm"
      aria-label={props.label}
      data-tooltip={props.label}
      data-tooltip-place="bottom"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
