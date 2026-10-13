/**
 * Select on Base UI: behaviour, keyboard and accessibility from Base UI, the
 * look from the inspector's own CSS (`.select-*`).
 */
import { Select as BaseSelect } from '@base-ui/react/select';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Icon } from '../icons.js';

export const Select = BaseSelect.Root;

export function SelectTrigger(
  props: Omit<ComponentPropsWithoutRef<typeof BaseSelect.Trigger>, 'className'>,
) {
  const { children, ...rest } = props;

  return (
    <BaseSelect.Trigger {...rest} className="select-trigger">
      {children}
      <BaseSelect.Icon className="select-icon">
        <Icon name="chevron-down" size={12} />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectValue() {
  return <BaseSelect.Value className="select-value" />;
}

/** The popup, below the trigger and aligned to its end. */
export function SelectContent(props: { readonly children: ReactNode }) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        className="select-positioner"
        side="bottom"
        align="end"
        sideOffset={6}
        alignItemWithTrigger={false}
      >
        <BaseSelect.Popup className="select-popup">
          <BaseSelect.List className="select-list">
            {props.children}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem(props: {
  readonly value: string;
  readonly children: ReactNode;
}) {
  return (
    <BaseSelect.Item value={props.value} className="select-item">
      <BaseSelect.ItemText className="select-item-text">
        {props.children}
      </BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="select-item-indicator">
        <Icon name="check" size={12} />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}
