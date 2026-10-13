/**
 * Dialog on Base UI: focus trapping, dismissal and scroll locking from Base UI,
 * the look from the inspector's own CSS (`.dialog-*`).
 */
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import type { ReactNode } from 'react';
import { Icon } from '../icons.js';

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;

/** A centred popup over a dimmed backdrop, titled, with a close button. */
export function DialogContent(props: {
  readonly title: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="dialog-backdrop" />
      <BaseDialog.Popup
        className={`dialog-popup${props.className ? ` ${props.className}` : ''}`}
      >
        <div className="dialog-head">
          <BaseDialog.Title className="dialog-title">
            {props.title}
          </BaseDialog.Title>
          <BaseDialog.Close className="dialog-close" aria-label="Close">
            <Icon name="x" size={14} />
          </BaseDialog.Close>
        </div>
        <div className="dialog-body">{props.children}</div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
