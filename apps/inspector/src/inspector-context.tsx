import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { DevClient } from './connection/client.js';
import type { InspectorState } from './connection/store.js';

const DevClientContext = createContext<DevClient | null>(null);

export function DevClientProvider(props: {
  readonly client: DevClient;
  readonly children: ReactNode;
}) {
  return (
    <DevClientContext.Provider value={props.client}>
      {props.children}
    </DevClientContext.Provider>
  );
}

export function useDevClient(): DevClient {
  const client = useContext(DevClientContext);

  if (!client) throw new Error('DevClientProvider is missing');

  return client;
}

export function useInspectorState(): InspectorState {
  const client = useDevClient();

  return useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );
}
