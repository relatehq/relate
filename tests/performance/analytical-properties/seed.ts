import type { Customer, Event, Values } from './model.js';
import { since, until } from './model.js';

export const workloadVersion = 2;

export function customers(count: number): Customer[] {
  return Array.from({ length: count }, (_, i) => ({
    key: String(i).padStart(8, '0'),
    name: `Customer ${i}`,
    portfolio: i % 5 === 0 ? 'south' : 'north',
  }));
}

/** Fixed PRNG, skewed activity, out-of-window events, non-logins and empty customers. */
export function* events(
  customerCount: number,
  count: number,
  seed: number,
): Generator<Event> {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

    return state / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const customer = Math.floor(random() ** 2 * Math.max(1, customerCount - 2));
    const day = Math.floor(random() * 40);

    yield {
      customer: String(customer).padStart(8, '0'),
      type: random() < 0.7 ? 'login' : 'view',
      at: new Date(Date.UTC(2026, 9, 1 + day)).toISOString(),
    };
  }
}

export function summarize(
  rows: Iterable<Event>,
  result = new Map<string, Values>(),
): Map<string, Values> {
  for (const row of rows) {
    if (row.type !== 'login' || row.at < since || row.at >= until) continue;

    const value = result.get(row.customer) ?? {
      loginCount: '0',
      lastLogin: null,
    };

    value.loginCount = String(BigInt(value.loginCount) + 1n);
    value.lastLogin =
      value.lastLogin === null || row.at > value.lastLogin
        ? row.at
        : value.lastLogin;
    result.set(row.customer, value);
  }

  return result;
}

/** Feed insertion and the mock summary from one bounded-memory event stream. */
export function* summarizedEvents(
  rows: Iterable<Event>,
  values: Map<string, Values>,
): Generator<Event> {
  for (const row of rows) {
    summarize([row], values);
    yield row;
  }
}
