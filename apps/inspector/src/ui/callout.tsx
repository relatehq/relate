import type { ReactNode } from 'react';
import { Button } from './button.js';

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
