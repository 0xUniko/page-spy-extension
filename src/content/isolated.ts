import { matchCurrentTab } from '../utils';
import { PAGE_SPY_EXTENSION_CONFIG_KEY } from './constant';
import { isEqual } from 'lodash-es';

chrome.storage.local.get('pagespy', ({ pagespy }) => {
  const cache = JSON.parse(
    sessionStorage.getItem(PAGE_SPY_EXTENSION_CONFIG_KEY) || '{}'
  );
  if (pagespy) {
    if (isEqual(pagespy, cache)) return;

    sessionStorage.setItem(
      PAGE_SPY_EXTENSION_CONFIG_KEY,
      JSON.stringify(pagespy)
    );
    window.location.reload();
  } else {
    sessionStorage.removeItem(PAGE_SPY_EXTENSION_CONFIG_KEY);
    sessionStorage.removeItem('page-spy-room');
  }
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.pagespy) {
    const { newValue } = changes.pagespy;
    sessionStorage.setItem(
      PAGE_SPY_EXTENSION_CONFIG_KEY,
      JSON.stringify(newValue)
    );

    const isMatched = matchCurrentTab(newValue.domainRules, location.origin);
    const isRunning =
      sessionStorage.getItem('page-spy-room') ||
      document.querySelector('#__pageSpy');

    if (!isMatched && isRunning) {
      sessionStorage.removeItem('page-spy-room');
    }
    if (isMatched || isRunning) {
      window.location.reload();
    }
  }
});

const BRIDGE_SCOPE = 'pagespy-bridge';
const BRIDGE_FETCH = 'pagespy:fetch';
const WS_OPEN = 'pagespy:ws-open';
const WS_SEND = 'pagespy:ws-send';
const WS_CLOSE = 'pagespy:ws-close';

let wsPort: chrome.runtime.Port | null = null;

function ensureWsPort() {
  if (wsPort) return wsPort;

  wsPort = chrome.runtime.connect({ name: 'pagespy-ws' });
  wsPort.onMessage.addListener((msg) => {
    window.postMessage(
      {
        scope: BRIDGE_SCOPE,
        type: 'pagespy:ws-event',
        payload: msg
      },
      '*'
    );
  });
  wsPort.onDisconnect.addListener(() => {
    wsPort = null;
  });

  return wsPort;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.scope !== BRIDGE_SCOPE) return;

  if (msg.type === BRIDGE_FETCH) {
    chrome.runtime.sendMessage(
      { type: BRIDGE_FETCH, payload: msg.payload },
      (response) => {
        window.postMessage(
          {
            scope: BRIDGE_SCOPE,
            type: `${BRIDGE_FETCH}:response`,
            requestId: msg.requestId,
            payload: response,
            error: chrome.runtime.lastError?.message
          },
          '*'
        );
      }
    );
    return;
  }

  if ([WS_OPEN, WS_SEND, WS_CLOSE].includes(msg.type)) {
    const port = ensureWsPort();
    port?.postMessage(msg);
  }
});
