import { PzEvent } from './pz-event';
import { PzEventType } from './pz-event-type';
import { PzIdentity } from './pz-identity';

export class PzPendingEvent {
  private id?: string;
  private subtype?: string;
  private identity: PzIdentity | null;
  private value?: string;
  private ts?: Date;
  private properties: Record<string, unknown>;
  private metadata?: Record<string, unknown>;
  private signalTitle?: string;
  private signalError?: Error;

  constructor(
    private readonly type: PzEventType,
    readonly defaultIdentity: PzIdentity | null,
    readonly eventProperties: Record<string, unknown>,
    private readonly sendFn: (data: PzEvent) => void,
    private readonly privatizeText: (text: string) => string,
    private readonly eventIdGenerator?: () => string,
  ) {
    this.identity = defaultIdentity;
    this.properties = { ...eventProperties };
  }

  identify(id: null | string | Record<string, string>, metadata?: Record<string, unknown>): PzPendingEvent {
    if (id === null) {
      this.identity = { actors: {}, properties: {} };
      return this;
    }

    this.identity = (typeof id === 'object')
      ? { actors: id, properties: { ...metadata } }
      : { actors: { user: id }, properties: { ...metadata } };
    return this;
  }

  send() {
    if (this.identity) this.properties['identity'] = this.identity.properties;
    if (this.metadata) this.properties['metadata'] = this.metadata;

    if (!this.value && (this.type === 'Tracked' || this.type === 'Logged')) {
      // console.trace('TODO: Unable to send Tracked or Logged events without a value', this);
      return;
    }

    if (this.type === 'Signal') {
      this.properties['title'] = this.privatizeText(this.signalTitle ?? '');
      if (this.signalError) this.properties['error'] = { name: this.signalError.name, stack: this.signalError.stack };
    }

    this.sendFn({
      id: this.id ?? this.eventIdGenerator?.(),
      type: this.type,
      subtype: this.subtype?.trim(),
      value: this.value,
      identity: this.identity?.actors,
      ts: this.ts ?? new Date(),
      properties: this.properties,
    } as PzEvent);
  }

  setSignalError(error?: Error): PzPendingEvent {
    if (this.type !== 'Signal') throw new Error('Must be of Signal type');
    this.signalError = error;
    return this;
  }

  setSignalTitle(title: string): PzPendingEvent {
    if (this.type !== 'Signal') throw new Error('Must be of Signal type');
    this.signalTitle = title;
    return this;
  }

  setId(id: string): PzPendingEvent {
    this.id = id;
    return this;
  }

  setSubtype(subtype: string): PzPendingEvent {
    this.subtype = subtype;
    return this;
  }

  setValue(value: string): PzPendingEvent {
    this.value = this.type === 'Signal' ? value : this.privatizeText(value);
    return this;
  }

  setTs(ts: Date): PzPendingEvent {
    this.ts = ts;
    return this;
  }

  setMetadata(metadata?: Record<string, unknown>): PzPendingEvent {
    this.metadata = { ...metadata };
    return this;
  }

  setProperties(properties: Record<string, unknown>): PzPendingEvent {
    this.properties = properties;
    return this;
  }
}
