import { PzEventType } from './pz-event-type';

export interface PzEvent {
  readonly id: string;
  readonly type: PzEventType;
  subtype?: string;
  readonly identity: Record<string, string>;
  value?: string;
  readonly ts: Date;
  readonly properties: Record<string, unknown>;
}
