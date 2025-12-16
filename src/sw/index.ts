import { matchCurrentTab } from '../utils';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['pagespy']);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  const { url, tabId } = details;
  if (!Number.isFinite(+tabId)) return;
  if (!url.startsWith('http')) return;

  const { pagespy } = (await chrome.storage.local.get('pagespy')) as {
    pagespy: I.Config;
  };
  if (!pagespy || !pagespy.domainRules.trim()) return;

  const isMatched = matchCurrentTab(pagespy.domainRules, url);

  if (isMatched) {
    chrome.action.setBadgeBackgroundColor({
      color: '#17ae49'
    });
    chrome.action.setBadgeText({
      tabId,
      text: 'on'
    });
    chrome.action.setBadgeTextColor({
      color: 'white'
    });
  } else {
    chrome.action.setBadgeText({
      tabId,
      text: ''
    });
  }
});

type SerializedBody =
  | { type: 'none' }
  | { type: 'text'; value: string }
  | { type: 'arrayBuffer'; buffer: Uint8Array }
  | { type: 'blob'; buffer: Uint8Array; mime?: string }
  | {
      type: 'formData';
      entries: Array<
        | { key: string; valueType: 'text'; value: string }
        | {
            key: string;
            valueType: 'file';
            name: string;
            mime?: string;
            buffer: Uint8Array;
          }
      >;
    };

const BRIDGE_MESSAGE_TYPE = 'pagespy:fetch';
const WS_PORT_NAME = 'pagespy-ws';
const WS_OPEN = 'pagespy:ws-open';
const WS_SEND = 'pagespy:ws-send';
const WS_CLOSE = 'pagespy:ws-close';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== BRIDGE_MESSAGE_TYPE) return;

  handleProxiedFetch(message.payload)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err: Error) => sendResponse({ ok: false, error: err.message }));

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== WS_PORT_NAME) return;

  const sockets = new Map<string, WebSocket>();

  const cleanupSocket = (wsId: string) => {
    const ws = sockets.get(wsId);
    if (!ws) return;
    try {
      ws.close();
    } catch (e) {
      console.warn('[PageSpy Extension] Close WS failed', e);
    }
    sockets.delete(wsId);
  };

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    const { wsId } = msg;

    switch (msg.type) {
      case WS_OPEN: {
        try {
          const ws = new WebSocket(msg.url, msg.protocols || undefined);

          ws.onopen = () => {
            port.postMessage({ wsId, event: 'open' });
          };
          ws.onmessage = (evt) => {
            const data =
              typeof evt.data === 'string'
                ? evt.data
                : evt.data instanceof ArrayBuffer
                  ? new Uint8Array(evt.data)
                  : null;
            port.postMessage({ wsId, event: 'message', data });
          };
          ws.onerror = (evt) => {
            port.postMessage({
              wsId,
              event: 'error',
              error:
                (evt instanceof ErrorEvent && evt.message) ||
                'WebSocket error'
            });
          };
          ws.onclose = (evt) => {
            port.postMessage({
              wsId,
              event: 'close',
              code: evt.code,
              reason: evt.reason,
              wasClean: evt.wasClean
            });
            cleanupSocket(wsId);
          };

          sockets.set(wsId, ws);
        } catch (error: any) {
          port.postMessage({
            wsId,
            event: 'error',
            error: error?.message || 'Create WebSocket failed'
          });
        }
        break;
      }
      case WS_SEND: {
        const ws = sockets.get(wsId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          port.postMessage({
            wsId,
            event: 'error',
            error: 'WebSocket is not open'
          });
          return;
        }
        try {
          ws.send(msg.data);
        } catch (error: any) {
          port.postMessage({
            wsId,
            event: 'error',
            error: error?.message || 'Send message failed'
          });
        }
        break;
      }
      case WS_CLOSE: {
        const ws = sockets.get(wsId);
        try {
          ws?.close(msg.code, msg.reason);
        } catch (error: any) {
          port.postMessage({
            wsId,
            event: 'error',
            error: error?.message || 'Close WebSocket failed'
          });
        } finally {
          cleanupSocket(wsId);
        }
        break;
      }
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    sockets.forEach((ws) => {
      try {
        ws.close();
      } catch (e) {
        console.warn('[PageSpy Extension] Close WS on disconnect failed', e);
      }
    });
    sockets.clear();
  });
});

async function handleProxiedFetch(payload: {
  url: string;
  init?: RequestInit & { body?: SerializedBody };
}) {
  const { url, init } = payload;
  const reqInit: RequestInit = init ? { ...init } : {};
  if ('body' in reqInit) {
    delete (reqInit as any).body;
  }

  if (init?.headers) {
    reqInit.headers = new Headers(init.headers as any);
  }

  if (init?.body) {
    reqInit.body = deserializeBody(init.body);
  }

  const res = await fetch(url, reqInit);
  const headers = Array.from(res.headers.entries());
  const body = await res.text();

  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body
  };
}

function deserializeBody(body: SerializedBody): BodyInit | undefined {
  switch (body.type) {
    case 'none':
      return undefined;
    case 'text':
      return body.value;
    case 'arrayBuffer':
      return body.buffer;
    case 'blob':
      return new Blob([body.buffer], { type: body.mime || '' });
    case 'formData': {
      const form = new FormData();
      body.entries.forEach((entry) => {
        if (entry.valueType === 'text') {
          form.append(entry.key, entry.value);
        } else {
          const file = new File([entry.buffer], entry.name, {
            type: entry.mime || ''
          });
          form.append(entry.key, file);
        }
      });
      return form;
    }
    default:
      return undefined;
  }
}
