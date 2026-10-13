import type { ComponentPropsWithRef, ReactNode } from 'react';

type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'className'> & {
  readonly variant?: 'ghost' | 'solid';
  /** Pressed or open: a toggle that is on, or the trigger of an open popup. */
  readonly active?: boolean;
};

/**
 * The design system's Button. Extra props reach the `<button>`, so it also
 * serves as a Base UI trigger through `render`.
 */
export function Button({ variant, active, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`button button-${variant ?? 'ghost'}${active ? ' active' : ''}`}
    />
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
