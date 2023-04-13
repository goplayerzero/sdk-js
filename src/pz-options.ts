import { Console } from 'console';
import { PzEvent } from './pz-event';

export interface PzOptions {
  dataset?: string; // default 'default'
  prod?: boolean; // default true
  batchEventsSize?: number; // default 100
  debounceInMs?: number; // default 2000ms
  privacy?: (text: string) => string;
  endpoint?: string; // default sdk.playerzero.app
  eventIdGenerator?: () => string; // default uuid package
  eventProperties?: Record<string, unknown>;
  dequeuedEvents?: (event: PzEvent[]) => void;
  queuedEvent?: (event: PzEvent) => void;
  restoreQueue?: () => Promise<PzEvent[]>; // invoked at initialization time to restore queued events
  intercept?: Console; // if console interception is desired
}
