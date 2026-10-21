import { effectivePrincipal } from './connection/store.js';
import { choosePrincipal, useChosenPrincipal } from './principal.js';
import type { ModelSnapshot } from './protocol.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';

/** Choose which declared development principal the agent and playground act as. */
export function PrincipalSelector(props: { readonly model: ModelSnapshot }) {
  const graphId = props.model.manifest.graphDefinitionId;
  const chosen = useChosenPrincipal(graphId);
  const active = effectivePrincipal(props.model, chosen);

  if (active === null)
    return (
      <span
        className="principal-none"
        title="Declare principals in defineGraph({ principals }) to act as a development identity"
      >
        no principals
      </span>
    );

  return (
    <span className="principal-select">
      <span className="principal-label">as</span>
      <Select
        value={active}
        onValueChange={(name) => {
          if (name !== null) choosePrincipal(graphId, name);
        }}
      >
        <SelectTrigger aria-label="Development principal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.model.principals.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}
