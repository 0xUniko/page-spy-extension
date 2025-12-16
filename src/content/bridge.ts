import { matchCurrentTab } from '../utils';
import { PAGE_SPY_EXTENSION_CONFIG_KEY } from './constant';

const BRIDGE_SCOPE = 'pagespy-bridge';
const BRIDGE_FETCH = 'pagespy:fetch';
const WS_OPEN = 'pagespy:ws-open';
const WS_SEND = 'pagespy:ws-send';
const WS_CLOSE = 'pagespy:ws-close';

type FormDataEntryPayload =
  | { key: string; valueType: 'text'; value: string }
  | {
      key: string;
      valueType: 'file';
      name: string;
      mime?: string;
      buffer: Uint8Array;
    };

type SerializedBody =
  | { type: 'none' }
  | { type: 'text'; value: string }
  | { type: 'arrayBuffer'; buffer: Uint8Array }
  | { type: 'blob'; buffer: Uint8Array; mime?: string }
  | { type: 'formData'; entries: FormDataEntryPayload[] };

type SerializedInit = {
  headers?: [string, string][];
  method?: string;
  credentials?: RequestCredentials;
  body?: SerializedBody;
};

type FetchResponsePayload = {
  ok?: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  error?: string;
};

const pendingFetches = new Map<
  string,
  { resolve: (data: FetchResponsePayload) => void; reject: (e: Error) => void }
>();
const socketMap = new Map<string, BridgeWebSocket>();

type ExtensionConfig = {
  domainRules: string;
  enableSSL: boolean;
  serviceAddress: string;
};

function readCachedConfig(): ExtensionConfig | null {
  const cache = sessionStorage.getItem(PAGE_SPY_EXTENSION_CONFIG_KEY);
  if (!cache) return null;
  try {
    const parsed = JSON.parse(cache);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ExtensionConfig;
  } catch {
    return null;
  }
}

function isEnabledForCurrentPage(config: ExtensionConfig | null): boolean {
  if (!config?.domainRules) return false;
  return matchCurrentTab(config.domainRules, location.origin);
}

function getTargetHost(config: ExtensionConfig | null): string | null {
  if (!config?.serviceAddress) return null;
  const scheme = config.enableSSL ? 'https://' : 'http://';
  try {
    const { pathname, host } = new URL(`${scheme}${config.serviceAddress}`);
    const address = pathname.endsWith('/')
      ? `${host}${pathname.slice(0, -1)}`
      : `${host}${pathname}`;
    const clientOrigin = `${scheme}${address}`;
    return new URL(clientOrigin).host;
  } catch {
    return null;
  }
}

export function installBridge() {
  const globalThisAny = window as any;
  if (globalThisAny.__PAGE_SPY_BRIDGE__) return;
  globalThisAny.__PAGE_SPY_BRIDGE__ = true;

  window.addEventListener('message', handleBridgeMessage);

  const originalFetch = window.fetch.bind(window);
  const OriginalWebSocket = window.WebSocket;

  window.fetch = createProxiedFetch(originalFetch);
  window.WebSocket = createProxiedWebSocket(OriginalWebSocket) as any;
}

function handleBridgeMessage(event: MessageEvent) {
  const { data } = event;
  if (!data || data.scope !== BRIDGE_SCOPE) return;

  if (data.type === `${BRIDGE_FETCH}:response`) {
    const pending = pendingFetches.get(data.requestId);
    pendingFetches.delete(data.requestId);
    if (!pending) return;

    const errorMsg = data.error || (!data.payload?.ok && data.payload?.error);
    if (errorMsg) {
      pending.reject(new Error(errorMsg));
      return;
    }

    pending.resolve(data.payload as FetchResponsePayload);
  }

  if (data.type === 'pagespy:ws-event') {
    const payload = data.payload;
    const ws = socketMap.get(payload?.wsId);
    ws?.handleRemoteEvent(payload);
  }
}

function shouldProxyUrl(targetUrl: URL): boolean {
  const config = readCachedConfig();
  if (!isEnabledForCurrentPage(config)) return false;
  const host = getTargetHost(config);
  if (!host) return false;
  return targetUrl.host === host;
}

function createProxiedFetch(originalFetch: typeof fetch): typeof fetch {
  return (async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const targetUrl = new URL(urlStr, location.href);

    if (!shouldProxyUrl(targetUrl)) {
      return originalFetch(input as any, init as any);
    }

    const requestId = genId('fetch');
    const serializedInit = await serializeInit(init);

    const responsePromise = new Promise<FetchResponsePayload>((resolve, reject) =>
      pendingFetches.set(requestId, { resolve, reject })
    );

    window.postMessage(
      {
        scope: BRIDGE_SCOPE,
        type: BRIDGE_FETCH,
        requestId,
        payload: {
          url: targetUrl.toString(),
          init: serializedInit
        }
      },
      '*'
    );

    const payload = await responsePromise;
    if (!payload || payload.ok === false) {
      throw new Error(payload?.error || 'Request failed');
    }

    const headers = new Headers(payload.headers);
    return new Response(payload.body, {
      status: payload.status,
      statusText: payload.statusText,
      headers
    });
  }) as typeof fetch;
}

function createProxiedWebSocket(OriginalWebSocket: typeof WebSocket) {
  const factory = function (
    url: string | URL,
    protocols?: string | string[]
  ): BridgeWebSocket | WebSocket {
    const targetUrl = new URL(
      typeof url === 'string' ? url : url.toString(),
      location.href
    );
    if (!shouldProxyUrl(targetUrl)) {
      return new OriginalWebSocket(url as any, protocols as any);
    }
    return new BridgeWebSocket(targetUrl.toString(), protocols);
  };

  factory.prototype = BridgeWebSocket.prototype;
  factory.CONNECTING = OriginalWebSocket.CONNECTING;
  factory.OPEN = OriginalWebSocket.OPEN;
  factory.CLOSING = OriginalWebSocket.CLOSING;
  factory.CLOSED = OriginalWebSocket.CLOSED;

  return factory;
}

class BridgeWebSocket extends EventTarget {
  static CONNECTING = WebSocket.CONNECTING;
  static OPEN = WebSocket.OPEN;
  static CLOSING = WebSocket.CLOSING;
  static CLOSED = WebSocket.CLOSED;

  readyState: number = BridgeWebSocket.CONNECTING;
  url: string;
  protocol = '';
  binaryType: BinaryType = 'blob';
  wsId: string;

  onopen: ((this: WebSocket, ev: Event) => any) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;
  onerror: ((this: WebSocket, ev: Event) => any) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.wsId = genId('ws');
    socketMap.set(this.wsId, this);

    const protocolList = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : [];

    window.postMessage(
      {
        scope: BRIDGE_SCOPE,
        type: WS_OPEN,
        wsId: this.wsId,
        url,
        protocols: protocolList
      },
      '*'
    );
  }

  send(data: any) {
    if (this.readyState !== BridgeWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    window.postMessage(
      { scope: BRIDGE_SCOPE, type: WS_SEND, wsId: this.wsId, data },
      '*'
    );
  }

  close(code?: number, reason?: string) {
    if (this.readyState === BridgeWebSocket.CLOSED) return;
    this.readyState = BridgeWebSocket.CLOSING;
    window.postMessage(
      {
        scope: BRIDGE_SCOPE,
        type: WS_CLOSE,
        wsId: this.wsId,
        code,
        reason
      },
      '*'
    );
  }

  handleRemoteEvent(payload: any) {
    switch (payload?.event) {
      case 'open':
        this.readyState = BridgeWebSocket.OPEN;
        this.dispatchSocketEvent('open', new Event('open'));
        break;
      case 'message': {
        const data =
          payload.data instanceof Uint8Array && this.binaryType === 'arraybuffer'
            ? payload.data.buffer
            : payload.data;
        const evt = new MessageEvent('message', { data });
        this.dispatchSocketEvent('message', evt);
        break;
      }
      case 'error':
        this.dispatchSocketEvent('error', new Event('error'));
        break;
      case 'close':
        this.readyState = BridgeWebSocket.CLOSED;
        socketMap.delete(this.wsId);
        this.dispatchSocketEvent(
          'close',
          new CloseEvent('close', {
            code: payload.code,
            reason: payload.reason,
            wasClean: Boolean(payload.wasClean)
          })
        );
        break;
      default:
        break;
    }
  }

  private dispatchSocketEvent(type: string, event: Event) {
    const handlerName = `on${type}` as
      | 'onopen'
      | 'onmessage'
      | 'onerror'
      | 'onclose';
    const handler = (this as any)[handlerName];
    if (typeof handler === 'function') {
      handler.call(this, event);
    }
    this.dispatchEvent(event);
  }
}

async function serializeInit(init?: RequestInit): Promise<SerializedInit> {
  if (!init) return {};

  const headers = init.headers
    ? Array.from(new Headers(init.headers as any).entries())
    : undefined;

  return {
    headers,
    method: init.method,
    credentials: init.credentials,
    body: await serializeBody(init.body)
  };
}

async function serializeBody(body?: BodyInit | null): Promise<SerializedBody> {
  if (!body) return { type: 'none' };

  if (typeof body === 'string') return { type: 'text', value: body };

  if (body instanceof URLSearchParams) {
    return { type: 'text', value: body.toString() };
  }

  if (body instanceof FormData) {
    const entries: FormDataEntryPayload[] = [];
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        entries.push({ key, valueType: 'text', value });
      } else {
        const buffer = new Uint8Array(await value.arrayBuffer());
        entries.push({
          key,
          valueType: 'file',
          name: value.name,
          mime: value.type,
          buffer
        });
      }
    }
    return { type: 'formData', entries };
  }

  if (body instanceof Blob) {
    const buffer = new Uint8Array(await body.arrayBuffer());
    return { type: 'blob', buffer, mime: body.type };
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const buffer = body instanceof ArrayBuffer ? body : body.buffer;
    return { type: 'arrayBuffer', buffer: new Uint8Array(buffer) };
  }

  return { type: 'none' };
}

function genId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

