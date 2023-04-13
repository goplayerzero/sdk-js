import { PzEvent } from './pz-event';
import { PzEventType } from './pz-event-type';
import { PzIdentity } from './pz-identity';
import { PzOptions } from './pz-options';
import { PzPendingEvent } from './pz-pending-event';

export class PzApi {
  private static readonly CHECKS = new RegExp(
    '\\b\\d{3}-?\\d{2}-?\\d{4}\\b' // SSN
    + '|\\b(?:(?:\\d{3,4})[ -]?){4}\\b' // CC
    , 'gm');
  private static instances: Map<string, PzApi> = new Map<string, PzApi>();
  private readonly dataset: string;
  private readonly prod: boolean;
  private readonly batchEventsSize: number;
  private readonly debounceInMs: number;
  private readonly privacy?: (text: string) => string;
  private readonly endpoint: string;
  private readonly eventIdGenerator?: () => string;
  private readonly eventProperties: Record<string, unknown>;
  private readonly eventQ: PzEvent[] = [];
  private identification: PzIdentity | null = { actors: {}, properties: {} };
  private debounceInterval?: ReturnType<typeof setInterval>;
  private dequeuedEvents?: (event: PzEvent[]) => void;
  private queuedEvent?: (event: PzEvent) => void;

  private constructor(
    private readonly apiToken: string,
    options?: PzOptions,
  ) {
    this.dataset = options?.dataset ?? 'default';
    this.prod = options?.prod ?? true;
    this.batchEventsSize = options?.batchEventsSize ?? 100;
    this.debounceInMs = options?.debounceInMs ?? 2000;
    this.privacy = options?.privacy;
    this.endpoint = `${options?.endpoint ?? 'https://sdk.playerzero.app'}/data`;
    this.eventIdGenerator = options?.eventIdGenerator;
    this.eventProperties = { ...options?.eventProperties ?? {} };
    if (options?.restoreQueue !== undefined) {
      options.restoreQueue().then(events => this.publishEvents(events));
    }
    this.queuedEvent = options?.queuedEvent;
    this.dequeuedEvents = options?.dequeuedEvents;
    if (options?.intercept) this.wrapConsole(options.intercept);

    console.assert(this.batchEventsSize >= 0, 'Negative batch sizes are not supported');
  }

  public static getInstance(apiToken: string, options?: PzOptions): PzApi {
    if (!this.instances.has(apiToken)) this.instances.set(apiToken, new PzApi(apiToken, options));
    return this.instances.get(apiToken) ?? new PzApi(apiToken, options);
  }

  withIdentify(id: null | string | Record<string, string>, metadata: Record<string, unknown> | undefined, action: () => void) {
    const current: PzIdentity = { ...this.identification } as PzIdentity;
    try {
      this.identify(id, metadata);
      action();
    } finally {
      this.identification = current;
    }
  }

  identify(id: null | string | Record<string, string>, metadata?: Record<string, unknown>) {
    if (id === null) {
      this.identification = { actors: {}, properties: {} };
      return;
    }

    this.identification = (typeof id === 'object')
      ? { actors: id, properties: metadata }
      : { actors: { User: id }, properties: metadata };
  }

  // TODO: Function to update identify metadata; removing any null or undefined values as well
  pendingEvent(type: PzEventType): PzPendingEvent {
    return new PzPendingEvent(
      type,
      this.identification,
      this.eventProperties,
      this.publishEvents.bind(this),
      this.privatizeText.bind(this),
      this.eventIdGenerator,
    );
  }

  track(name: string, options?: { metadata?: Record<string, unknown>, type?: string }) {
    const identity = this.identification;
    if (identity === null || Object.keys(identity).length === 0) {
      // console.warn(`Tracked event '${name}' discarded due to lack of identification`);
      return;
    }
    const eventToSend = this.newEvent('Tracked', options?.metadata);
    if (options?.type !== undefined) eventToSend.setSubtype(options?.type);
    eventToSend.setValue(name);
    eventToSend.send();
  }

  log(message: string, options?: { metadata?: Record<string, unknown>, type?: string }) {
    const eventToSend = this.newEvent('Logged', options?.metadata);
    if (options?.type !== undefined) eventToSend.setSubtype(options?.type);
    eventToSend.setValue(message);
    eventToSend.send();
  }

  signal(
    reason: string | Error,
    options?: {
      reason?: string,
      error?: Error,
      fp?: string,
      metadata?: Record<string, unknown>,
      type?: string,
    }
  ) {
    let message = options?.reason;
    let error = options?.error;

    if (reason instanceof Error) error = reason;
    else message = reason;

    if (message === undefined) {
      if (error !== undefined) message = error.name ?? error.stack?.split('\n')?.pop();
      else return;
      if (message === undefined) return;
    }

    const eventToSend = this.newEvent('Signal', options?.metadata);
    if (options?.type !== undefined) eventToSend.setSubtype(options?.type);
    if (options?.fp !== undefined) eventToSend.setValue(options?.fp);
    eventToSend.setSignalTitle(message);
    eventToSend.setSignalError(error);
    eventToSend.send();
  }

  private wrapConsole(console: Console) {
    const originalRefs: Record<string, (...args: any) => void> = {};
    ['assert', 'debug', 'error', 'info', 'log', 'trace', 'warn'].forEach(key => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      originalRefs[key] = console[key].bind(console);
    });

    ['debug', 'info', 'log', 'warn'].forEach(key => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      console[key] = (message?: any, ...optionalParams: any[]) => {
        originalRefs[key](message, ...optionalParams);
        this.pendingEvent('Logged')
          .setSubtype(key.toUpperCase())
          .setValue([message, ...optionalParams].map(it => JSON.stringify(it, this.shallowRender)).join(' '))
          .send();
      };
    });

    console.error = (message?: any, ...optionalParams: any[]) => {
      originalRefs['error'](message, ...optionalParams);
      this.pendingEvent('Signal')
        .setSubtype('ERROR')
        .setSignalTitle([message, ...optionalParams].join(' '))
        .setSignalError(optionalParams.filter(it => it instanceof Error).pop())
        .send();
    };
  }

  private flushEventQ() {
    const payload = this.eventQ.splice(0, this.eventQ.length);
    if (this.debounceInterval !== undefined) {
      clearInterval(this.debounceInterval);
      this.debounceInterval = undefined;
    }
    if (payload.length === 0) return;

    fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'X-PlayerZeroSdk': `JavaScript __PlayerZeroSdkVersion__`,
        'X-PlayerZeroScope': `${!!this.prod} ${this.dataset}`,
      }
    })
      .catch(() => [])
      .then(() => this.dequeuedEvents?.(payload)); // intentional fire and forget
  }

  private privatizeText(text: string): string {
    if (text?.length > 1024 * 1024) return '';
    let cleansedText = text;
    if (this.privacy !== undefined) cleansedText = this.privacy(cleansedText);
    return cleansedText.replace(PzApi.CHECKS, '<redact>');
  }

  private newEvent(type: PzEventType, metadata?: Record<string, unknown>): PzPendingEvent {
    const event = this.pendingEvent(type);
    if (metadata !== undefined) event.setMetadata(metadata);
    event.setProperties(this.eventProperties);

    return event;
  }

  private publishEvents(data: PzEvent | PzEvent[]) {
    if (Array.isArray(data)) { // special restoration process
      if (data.length > 0) this.eventQ.push(...data);
      else return;
    } else {
      this.eventQ.push(data);
      this.queuedEvent?.(data);
    }

    if (this.eventQ.length >= this.batchEventsSize) return this.flushEventQ();

    if (this.debounceInterval !== undefined) {
      clearInterval(this.debounceInterval);
      this.debounceInterval = undefined;
    }
    this.debounceInterval = setInterval(() => this.flushEventQ(), this.debounceInMs);
  }

  private shallowRender(k: string, v: any): string {
    return k && v && typeof v !== 'number' ? Array.isArray(v) ? `[${v.join(',')}]` : '' + v : v;
  }
}
