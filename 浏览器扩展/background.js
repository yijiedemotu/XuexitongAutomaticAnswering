const ALLOWED_STORAGE_KEYS = new Set([
  'cx-auto-settings-v41',
  'cx-auto-panel-position-v41'
]);
const ALLOWED_API_HOSTS = new Set([
  'ark.cn-beijing.volces.com',
  'api.deepseek.com'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;

  if (message.type === 'CX_GET_VALUES') {
    chrome.storage.local.get([...ALLOWED_STORAGE_KEYS]).then(sendResponse).catch(() => sendResponse({}));
    return true;
  }

  if (message.type === 'CX_SET_VALUE') {
    if (!ALLOWED_STORAGE_KEYS.has(message.key)) {
      sendResponse({ ok: false, error: '不允许保存此设置项。' });
      return;
    }
    chrome.storage.local.set({ [message.key]: message.value })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message || '扩展存储失败。' }));
    return true;
  }

  if (message.type === 'CX_HTTP_REQUEST') {
    requestApi(message.request).then(sendResponse).catch(error => {
      sendResponse({ networkError: error && error.message || '网络请求失败。' });
    });
    return true;
  }
});

async function requestApi(request) {
  if (!request || typeof request.url !== 'string') return { networkError: '请求地址无效。' };
  if (request.method !== 'POST') return { networkError: '只允许 POST API 请求。' };
  let url;
  try { url = new URL(request.url); } catch (e) { return { networkError: '请求地址无效。' }; }
  if (url.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(url.hostname)) {
    return { networkError: '扩展未授权访问此 AI 服务地址。' };
  }

  const controller = new AbortController();
  const timeout = Math.max(1000, Math.min(Number(request.timeout) || 40000, 120000));
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url.href, {
      method: 'POST',
      headers: request.headers || {},
      body: typeof request.data === 'string' ? request.data : JSON.stringify(request.data || {}),
      signal: controller.signal
    });
    return {
      status: response.status,
      statusText: response.statusText,
      responseText: await response.text(),
      finalUrl: response.url
    };
  } catch (error) {
    if (error && error.name === 'AbortError') return { networkError: '请求超时。' };
    return { networkError: error && error.message || '无法连接到 AI 服务。' };
  } finally {
    clearTimeout(timer);
  }
}
