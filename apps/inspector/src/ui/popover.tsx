/**
 * Popover on Base UI: focus, dismissal and positioning from Base UI, the look
 * from the inspector's own CSS (`.popover-*`).
 */
import { Popover as BasePopover } from '@base-ui/react/popover';
import type { ReactNode } from 'react';

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

/** The popup, below the trigger and aligned to its end. */
export function PopoverContent(props: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        className="popover-positioner"
        side="bottom"
        align="end"
        sideOffset={6}
      >
        <BasePopover.Popup
          className={`popover-popup${props.className ? ` ${props.className}` : ''}`}
        >
          {props.children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export function PopoverTitle(props: { readonly children: ReactNode }) {
  return (
    <BasePopover.Title className="popover-title">
      {props.children}
    </BasePopover.Title>
  );
}

export function PopoverDescription(props: { readonly children: ReactNode }) {
  return (
    <BasePopover.Description className="popover-description">
      {props.children}
    </BasePopover.Description>
  );
}
