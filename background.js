// Draait als service worker; enige plek die daadwerkelijk met Jira praat.
// Voorkomt CORS-problemen en houdt het API-token uit het content script.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten cache per ticket
const ERROR_CACHE_TTL_MS = 30 * 1000; // korte cache voor fouten zodat herstel snel zichtbaar is
const KEY_REGEX = /^[A-Z]{2,3}-\d+$/;
const IN_FLIGHT_REQUESTS = new Map();

const ERROR_CODES = {
  INVALID_KEY: "ERR_INVALID_KEY",
  NOT_CONFIGURED: "ERR_NOT_CONFIGURED",
  INVALID_JIRA_URL: "ERR_INVALID_JIRA_URL",
  NOT_FOUND: "ERR_NOT_FOUND",
  AUTH_FAILED: "ERR_AUTH_FAILED",
  HTTP: "ERR_HTTP",
  NETWORK: "ERR_NETWORK"
};

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function buildError({ key, code, httpStatus }) {
  if (code === ERROR_CODES.HTTP) {
    return {
      ok: false,
      key,
      errorCode: code,
      httpStatus,
      error: t("errorHttp", [String(httpStatus)])
    };
  }

  const messageKeyByCode = {
    [ERROR_CODES.INVALID_KEY]: "errorInvalidKey",
    [ERROR_CODES.NOT_CONFIGURED]: "errorNotConfigured",
    [ERROR_CODES.INVALID_JIRA_URL]: "errorInvalidJiraUrl",
    [ERROR_CODES.NOT_FOUND]: "errorNotFound",
    [ERROR_CODES.AUTH_FAILED]: "errorAuthFailed",
    [ERROR_CODES.NETWORK]: "errorNetwork"
  };

  return {
    ok: false,
    key,
    errorCode: code,
    error: t(messageKeyByCode[code] || "errorUnknown")
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_JIRA_ISSUE") {
    fetchIssueWithCache(message.key).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CLEAR_JIRA_CACHE") {
    clearJiraCache().then(sendResponse);
    return true;
  }

  if (message.type === "TEST_JIRA_CONNECTION") {
    testJiraConnection().then(sendResponse);
    return true;
  }
});

async function fetchIssueWithCache(key) {
  const normalizedKey = (key || "").trim().toUpperCase();

  if (!KEY_REGEX.test(normalizedKey)) {
    return buildError({ key: normalizedKey || key, code: ERROR_CODES.INVALID_KEY });
  }

  if (IN_FLIGHT_REQUESTS.has(normalizedKey)) {
    return IN_FLIGHT_REQUESTS.get(normalizedKey);
  }

  const request = (async () => {
    const cacheKey = "jira_cache_" + normalizedKey;
    const cached = await chrome.storage.local.get(cacheKey);
    const entry = cached[cacheKey];

    if (entry && entry.data) {
      const ttl = entry.data.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS;
      if (Date.now() - entry.timestamp < ttl) {
        return entry.data;
      }
    }

    const data = await fetchIssueFromJira(normalizedKey);
    await chrome.storage.local.set({ [cacheKey]: { data, timestamp: Date.now() } });
    return data;
  })();

  IN_FLIGHT_REQUESTS.set(normalizedKey, request);
  try {
    return await request;
  } finally {
    IN_FLIGHT_REQUESTS.delete(normalizedKey);
  }
}

async function clearJiraCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith("jira_cache_"));
  if (cacheKeys.length) {
    await chrome.storage.local.remove(cacheKeys);
  }
  return { ok: true, removed: cacheKeys.length };
}

function normalizeJiraUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function toBase64(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

async function fetchIssueFromJira(key) {
  const settings = await chrome.storage.local.get(["jiraUrl", "jiraEmail", "jiraToken"]);

  if (!settings.jiraUrl || !settings.jiraEmail || !settings.jiraToken) {
    return buildError({ key, code: ERROR_CODES.NOT_CONFIGURED });
  }

  const cleanUrl = normalizeJiraUrl(settings.jiraUrl);
  if (!cleanUrl) {
    return buildError({ key, code: ERROR_CODES.INVALID_JIRA_URL });
  }

  const endpoint = `${cleanUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`;
  const auth = toBase64(`${settings.jiraEmail}:${settings.jiraToken}`);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    });

    if (response.status === 200) {
      const data = await response.json();
      return {
        ok: true,
        key: data.key,
        summary: data.fields.summary,
        status: data.fields.status.name,
        url: `${cleanUrl}/browse/${data.key}`
      };
    }
    if (response.status === 404) {
      return buildError({ key, code: ERROR_CODES.NOT_FOUND });
    }
    if (response.status === 401 || response.status === 403) {
      return buildError({ key, code: ERROR_CODES.AUTH_FAILED });
    }
    return buildError({ key, code: ERROR_CODES.HTTP, httpStatus: response.status });
  } catch (err) {
    return buildError({ key, code: ERROR_CODES.NETWORK });
  }
}

async function testJiraConnection() {
  const settings = await chrome.storage.local.get(["jiraUrl", "jiraEmail", "jiraToken"]);

  if (!settings.jiraUrl || !settings.jiraEmail || !settings.jiraToken) {
    return buildError({ code: ERROR_CODES.NOT_CONFIGURED });
  }

  const cleanUrl = normalizeJiraUrl(settings.jiraUrl);
  if (!cleanUrl) {
    return buildError({ code: ERROR_CODES.INVALID_JIRA_URL });
  }

  const endpoint = `${cleanUrl}/rest/api/3/myself`;
  const auth = toBase64(`${settings.jiraEmail}:${settings.jiraToken}`);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    });

    if (response.status === 200) {
      const profile = await response.json();
      return {
        ok: true,
        displayName: profile.displayName || settings.jiraEmail,
        jiraUrl: cleanUrl
      };
    }

    if (response.status === 401 || response.status === 403) {
      return buildError({ code: ERROR_CODES.AUTH_FAILED });
    }

    return buildError({ code: ERROR_CODES.HTTP, httpStatus: response.status });
  } catch (err) {
    return buildError({ code: ERROR_CODES.NETWORK });
  }
}
