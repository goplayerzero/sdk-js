export class PzApi {
  private static SPAN_COUNTER: number = Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
  private static readonly CHECKS = new RegExp(
    '\\b\\d{3}-?\\d{2}-?\\d{4}\\b' // SSN
    + '|\\b(?:(?:\\d{3,4})[ -]?){4}\\b' // CC
    , 'gm');

  private readonly dataset: string;
  private readonly prod: boolean;
  private readonly batchEventsSize: number;
  private readonly debounceInMs: number;
  private readonly endpoint: string;
  private readonly privacy?: (text: string) => string;
  private readonly dequeuedEvents?: (type: PzInsightType, events: PzInsight[]) => void;
  private readonly queuedEvent?: (type: PzInsightType, event: PzInsight) => void;

  private readonly insight: Record<PzInsightType, { debounce?: ReturnType<typeof setInterval>, q: PzInsight[] }> = {
    Track: { q: Array<PzTrackInsight>() },
    Log: { q: Array<PzLogInsight>() },
    Span: { q: Array<PzSpanInsight>() },
  };
  private currentIdentification?: PzUserIdentity;
  private currentIdentificationMetadata?: Record<string, any>;

  constructor(
    private readonly apiToken: string,
    options?: PzInsightOptions,
  ) {
    this.dataset = options?.dataset ?? 'default';
    this.prod = options?.prod ?? false;
    this.batchEventsSize = options?.batchEventsSize ?? 100;
    this.debounceInMs = options?.debounceInMs ?? 2000;
    this.endpoint = `${options?.endpoint ?? 'https://sdk.playerzero.app'}`;
    this.queuedEvent = options?.queuedEvent;
    this.dequeuedEvents = options?.dequeuedEvents;

    console.assert(this.batchEventsSize >= 0, 'Negative batch sizes are not supported');
  }

  identify(id: null | string | PzUserIdentity, metadata?: Record<string, any>) {
    if (id === null || id === undefined) {
      this.currentIdentification = undefined;
      return;
    }

    let cache = (typeof id === 'string')
      ? { userId: id }
      : { userId: id.userId, email: id.email, anonId: id.anonId };
    if (cache.userId === undefined) delete cache.userId;
    if (cache.email === undefined) delete cache.email;
    if (cache.anonId === undefined) delete cache.anonId;

    this.currentIdentification = cache;
    this.currentIdentificationMetadata = {};
    if (metadata === undefined) metadata = {};
    for (let key in (metadata ?? {})) {
      this.currentIdentificationMetadata[`identity.${key}`] = metadata[key];
    }
  }

  track(name: string, options?: PzTrackOptions) {
    const identity = this.currentIdentification;
    if (identity === undefined || (identity.userId === undefined && identity.anonId === undefined && identity.email === undefined)) return;

    this.publishInsights('Track', {
      id: options?.id,
      identity,
      value: name,
      type: options?.type,
      ts: options?.ts ?? new Date(),
      properties: { ...options?.properties, ...this.currentIdentificationMetadata },
      attributes: options?.attributes,
    } as PzTrackInsight);
  }

  log(type: PzLogType, message: string | Error, options?: PzLogOptions) {
    const properties: Record<string, string> = {};
    const error = (message instanceof Error) ? message : undefined;
    const logMsg = (error) ? error.message : message as string;
    const identity = { ...this.currentIdentification };

    if (options?.fp) properties['fp'] = options.fp;

    if (options?.exception?.message) properties['exception.message'] = options.exception.message;
    else if (error?.message) properties['exception.message'] = error.message;

    if (options?.exception?.type) properties['exception.type'] = options.exception.type;
    else if (error?.name) properties['exception.type'] = error.name;

    if (options?.exception?.stacktrace) properties['exception.stacktrace'] = options.exception.stacktrace;
    else if (error?.stack) properties['exception.stacktrace'] = error.stack;

    if (options?.traceId === undefined) {
      Object.assign(properties, this.currentIdentificationMetadata);
      if (identity?.userId) properties["identity.userId"] = identity.userId;
      if (identity?.email) properties["identity.email"] = identity.email;
      if (identity?.anonId) properties["identity.anonId"] = identity.anonId;
    }

    this.publishInsights('Log', {
      id: options?.id,
      traceId: options?.traceId,
      spanId: options?.spanId,
      type,
      value: this.privatizeText(logMsg),
      ts: options?.ts || new Date(),
      qty: options?.qty,
      properties: { ...options?.properties, ...properties },
      attributes: { ...options?.attributes },
    } as PzLogInsight);
  }

  span(traceId: string, type: string, name: string, duration: number, options?: PzSpanOptions) {
    const tid = this.transformId(traceId, 16);
    const end = new Date();
    const start = new Date(end.getTime() - duration);

    this.publishInsights('Span', {
      id: options?.id ?? PzApi.SPAN_COUNTER.toString(16).padStart(16, '0'),
      traceId: tid,
      spanId: options?.parentId,
      type,
      value: name,
      start,
      end,
      error: options?.error,
      events: options?.events,
      properties: options?.properties,
      attributes: options?.attributes,
    } as PzSpanInsight);
  }

  flush() {
    this.flushQ('Track');
    this.flushQ('Span');
    this.flushQ('Log');
  }

  private publishInsights(type: PzInsightType, data: PzInsight | PzInsight[]): void {
    if (!Array.isArray(data)) data = [data];
    if (data.length > 0) {
      this.insight[type].q.push(...data);
      data.forEach(it => this.queuedEvent?.(type, it));
    }

    if (this.insight[type].q.length >= this.batchEventsSize) return this.flushQ(type);
    if (this.insight[type].debounce !== undefined) {
      clearInterval(this.insight[type].debounce);
      this.insight[type].debounce = undefined;
    }
    this.insight[type].debounce = setInterval(() => this.flushQ(type), this.debounceInMs);
  }

  private flushQ(type: PzInsightType) {
    const insight = this.insight[type];
    const payload = insight.q.splice(0, insight.q.length);
    if (insight.debounce !== undefined) {
      clearInterval(insight.debounce);
      insight.debounce = undefined;
    }
    if (payload.length === 0) return;

    fetch(`${this.endpoint}/v2/${type.toLowerCase()}s`, {
      keepalive: true,
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'X-PzSdk': `JavaScript __PlayerZeroSdkVersion__`,
        'X-PzProd': `${this.prod}`,
        'X-PzBucket': `${this.dataset}`,
      }
    }).catch(() => []).then(() => this.dequeuedEvents?.(type, payload));
  }

  private privatizeText(text: string): string {
    if (text?.length > 1024 * 1024) return '';
    let cleansedText = text;
    if (this.privacy !== undefined) cleansedText = this.privacy(cleansedText);
    return cleansedText.replace(PzApi.CHECKS, '<redact>');
  }

  private transformId(rawId: string, size: 8 | 16): string {
    // let id: string = '';
    // if (rawId.length === size) id = rawId;
    // else if (rawId.length === size * 1.5) id = atob(rawId);
    // else if (rawId.length === size * 2) {
    //   const hex = rawId.replace('-', '');
    //   for (let i = 0; i < hex.length; i += 2)
    //     id += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
    // } else throw new Error(` Invalid id ${rawId}`);
    return rawId;
  }
}

export interface PzInsightOptions {
  dataset?: string; // default 'default'
  prod?: boolean; // default false
  batchEventsSize?: number; // default 100
  debounceInMs?: number; // default 2000ms
  endpoint?: string; // default sdk.playerzero.app
  privacy?: (text: string) => string;
  dequeuedEvents?: (type: PzInsightType, events: PzInsight[]) => void;
  queuedEvent?: (type: PzInsightType, event: PzInsight) => void;
  restoreQueue?: (type: PzInsightType) => Promise<PzInsight[]>; // invoked at initialization time to restore queued events
}

export type PzInsightType = 'Track' | 'Log' | 'Span';
export type PzLogType = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface PzInsight {
  readonly id?: string;
  readonly properties?: Record<string, string>;
}

export interface PzTrackInsight extends PzInsight {
  readonly identity: PzUserIdentity;
  readonly value: string;
  readonly type?: string;
  readonly ts: Date;
  readonly attributes?: Record<string, any>;
}

export interface PzTrackOptions {
  readonly id?: string;
  readonly type?: string;
  readonly ts?: Date; // defaults to new Date()
  readonly properties?: Record<string, string>;
  readonly attributes?: Record<string, any>;
}

export interface PzLogInsight extends PzInsight {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly type: PzLogType; // defaults to 'TRACE'
  readonly value: string;
  readonly ts: Date;
  readonly qty?: number;
  readonly attributes?: Record<string, any>;
}

export interface PzLogOptions {
  readonly id?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly ts?: Date; // defaults to new Date()
  readonly fp?: string;
  readonly qty?: number;
  readonly exception?: { message?: string, type?: string, stacktrace?: string };
  readonly properties?: Record<string, string>;
  readonly attributes?: Record<string, any>;
}

export interface PzSpanInsight extends PzInsight {
  readonly id: string;
  readonly traceId: string;
  readonly spanId?: string;
  readonly type: string;
  readonly value: string;
  readonly start: Date;
  readonly end: Date;
  readonly error?: string;
  readonly events?: PzSpanEvent[];
}

export interface PzSpanOptions {
  readonly id?: string; // defaults to complex internal logic
  readonly parentId?: string;
  readonly start?: Date;
  readonly end?: Date;
  readonly error?: string;
  readonly events?: PzSpanEvent[];
  readonly properties?: Record<string, string>;
  readonly attributes?: Record<string, any>;
}

export interface PzUserIdentity {
  readonly userId?: string;
  readonly email?: string;
  readonly anonId?: string;
}

export interface PzSpanEvent {
  readonly name: string;
  readonly ts: Date;
  readonly properties?: Record<string, string>;
}
