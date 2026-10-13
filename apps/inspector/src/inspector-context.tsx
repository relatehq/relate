import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import {
  TOUCH_MS,
  initialActivity,
  touchedDefinitions,
} from './connection/activity.js';
import type { ActivityClient, ActivityState } from './connection/activity.js';
import { initialAgent } from './connection/agent.js';
import type { AgentClient, AgentState } from './connection/agent.js';
import type { DevClient } from './connection/client.js';
import type { InspectorState } from './connection/store.js';

const DevClientContext = createContext<DevClient | null>(null);
const ActivityClientContext = createContext<ActivityClient | null>(null);
const AgentClientContext = createContext<AgentClient | null>(null);

export function DevClientProvider(props: {
  readonly client: DevClient;
  /** Optional so screens render without the activity stream (tests, older servers). */
  readonly activity?: ActivityClient;
  /** Optional for the same reason; the agent panel then shows nothing to talk to. */
  readonly agent?: AgentClient;
  readonly children: ReactNode;
}) {
  return (
    <DevClientContext.Provider value={props.client}>
      <ActivityClientContext.Provider value={props.activity ?? null}>
        <AgentClientContext.Provider value={props.agent ?? null}>
          {props.children}
        </AgentClientContext.Provider>
      </ActivityClientContext.Provider>
    </DevClientContext.Provider>
  );
}

const noAgent = {
  getState: () => initialAgent,
  subscribe: () => () => {},
};

/** The agent client, or null when the inspector runs without one. */
export function useAgentClient(): AgentClient | null {
  return useContext(AgentClientContext);
}

export function useAgent(): AgentState {
  const client = useContext(AgentClientContext) ?? noAgent;

  return useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );
}

const noActivity = {
  getState: () => initialActivity,
  subscribe: () => () => {},
};

export function useActivity(): ActivityState {
  const client = useContext(ActivityClientContext) ?? noActivity;

  return useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );
}

/** Object definition IDs operations touched just now; clears itself as they age. */
export function useTouchedDefinitions(): ReadonlySet<string> {
  const activity = useActivity();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const latest = Math.max(0, ...activity.touched.values());
    const remaining = latest + TOUCH_MS - Date.now();

    setNow(Date.now());

    if (remaining <= 0) return;

    const timer = setTimeout(() => setNow(Date.now()), remaining);

    return () => clearTimeout(timer);
  }, [activity.touched]);

  return useMemo(() => touchedDefinitions(activity, now), [activity, now]);
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
