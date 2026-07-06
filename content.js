// Scant zichtbare Gmail-rijen op Jira-keys en injecteert badges naast afzendernaam en geopende mail-header.

const JIRA_KEY_REGEX = /\b[A-Z]{2,3}-\d+\b/g;
const ROW_SELECTOR = "tr.zA";
const HEADER_SELECTOR = "h2.hP";
const ROW_TEXT_SELECTORS = [".y6", ".bog"];
const VISIBLE_NAME_SELECTORS = [".yW span[email]", ".yW span.yP", ".yW [email]"];
const MAX_BADGES_PER_ROW = 3;
const SCAN_DEBOUNCE_MS = 140;

const ROW_STATE = new WeakMap();
const ISSUE_IN_FLIGHT = new Map();

const pendingRows = new Set();
let headerDirty = true;
let scheduledFlush = null;
let lastLocationHref = window.location.href;
let headerFingerprint = "";
let headerRequestVersion = 0;

const STATUS_COLORS = {
  "to do": "#DFE1E6",
  "in progress": "#0052CC",
  done: "#00875A",
  default: "#6B778C"
};

function t(key, substitutions, fallback = "") {
  return chrome.i18n.getMessage(key, substitutions) || fallback || key;
}

function colorForStatus(status) {
  const key = (status || "").toLowerCase();
  return STATUS_COLORS[key] || STATUS_COLORS.default;
}

function textColorForStatus(status) {
  const key = (status || "").toLowerCase();
  return key === "to do" ? "#172B4D" : "#FFFFFF";
}

function normalizeKey(key) {
  return (key || "").trim().toUpperCase();
}

function extractKeys(text) {
  const matches = (text || "").toUpperCase().match(JIRA_KEY_REGEX) || [];
  return Array.from(new Set(matches)).slice(0, MAX_BADGES_PER_ROW);
}

function fetchIssue(key) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "FETCH_JIRA_ISSUE", key }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, key, errorCode: "ERR_EXTENSION_UNAVAILABLE", error: t("errorExtensionUnavailable") });
        return;
      }

      if (!response) {
        resolve({ ok: false, key, errorCode: "ERR_NO_RESPONSE", error: t("errorNoResponse") });
        return;
      }

      resolve(response);
    });
  });
}

function fetchIssueDeduped(rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) {
    return Promise.resolve({ ok: false, key: rawKey, errorCode: "ERR_INVALID_KEY", error: t("errorInvalidKey") });
  }

  if (ISSUE_IN_FLIGHT.has(key)) {
    return ISSUE_IN_FLIGHT.get(key);
  }

  const request = fetchIssue(key).finally(() => {
    ISSUE_IN_FLIGHT.delete(key);
  });

  ISSUE_IN_FLIGHT.set(key, request);
  return request;
}

function buildLoadingBadge(key) {
  const badge = document.createElement("span");
  badge.className = "jira-badge jira-badge--loading";
  badge.textContent = `${key} ...`;
  badge.title = t("badgeLoadingTitle");
  badge.setAttribute("aria-label", t("badgeLoadingAria", [key], `${key} loading`));
  return badge;
}

function buildBadge(issueData) {
  const badge = document.createElement("span");
  badge.className = "jira-badge";

  if (!issueData.ok) {
    const errorText = issueData.error || t("errorUnknown");
    badge.classList.add("jira-badge--error");
    badge.textContent = `${issueData.key} !`;
    badge.title = errorText;
    badge.setAttribute("aria-label", t("badgeErrorAria", [issueData.key, errorText], `${issueData.key} error: ${errorText}`));
    return badge;
  }

  badge.style.backgroundColor = colorForStatus(issueData.status);
  badge.style.color = textColorForStatus(issueData.status);
  badge.textContent = `${issueData.key} · ${issueData.status}`;
  badge.title = issueData.summary;
  badge.setAttribute("role", "button");
  badge.setAttribute("tabindex", "0");
  badge.setAttribute("aria-label", `${issueData.key} ${issueData.status}`);

  const openIssue = (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.open(issueData.url, "_blank", "noopener");
  };

  badge.addEventListener("click", openIssue);
  badge.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      openIssue(event);
    }
  });

  return badge;
}

function findVisibleNameWrapper(row) {
  for (const selector of VISIBLE_NAME_SELECTORS) {
    const visibleNameSpan = row.querySelector(selector);
    if (!visibleNameSpan) continue;

    return visibleNameSpan.closest(".bA4") || visibleNameSpan;
  }

  return null;
}

function getRowText(row) {
  for (const selector of ROW_TEXT_SELECTORS) {
    const node = row.querySelector(selector);
    if (node && node.textContent) {
      return node.textContent;
    }
  }

  return row.textContent || "";
}

function getOrCreateRowContainer(row, nameWrapper) {
  let container = row.querySelector('.jira-badge-container[data-jira-kind="row"]');
  if (container) {
    return container;
  }

  container = document.createElement("span");
  container.className = "jira-badge-container";
  container.setAttribute("data-jira-kind", "row");
  nameWrapper.insertAdjacentElement("afterend", container);
  return container;
}

function removeRowContainer(row) {
  const existingContainer = row.querySelector('.jira-badge-container[data-jira-kind="row"]');
  if (existingContainer) {
    existingContainer.remove();
  }
}

function queueRow(row) {
  if (!(row instanceof Element)) return;
  if (row.matches(ROW_SELECTOR)) {
    pendingRows.add(row);
    return;
  }

  const closest = row.closest(ROW_SELECTOR);
  if (closest) {
    pendingRows.add(closest);
  }
}

async function processRow(row) {
  if (!row || !row.isConnected) return;

  const rowText = getRowText(row);
  const keys = extractKeys(rowText);
  const fingerprint = `${keys.join(",")}|${rowText.slice(0, 250)}`;

  const previous = ROW_STATE.get(row);
  if (previous && previous.fingerprint === fingerprint) {
    return;
  }

  const version = (previous?.version || 0) + 1;
  ROW_STATE.set(row, { fingerprint, version });

  if (keys.length === 0) {
    removeRowContainer(row);
    return;
  }

  const nameWrapper = findVisibleNameWrapper(row);
  if (!nameWrapper) return;

  const container = getOrCreateRowContainer(row, nameWrapper);
  container.textContent = "";

  const loadingBadges = new Map();
  for (const key of keys) {
    const loadingBadge = buildLoadingBadge(key);
    loadingBadges.set(key, loadingBadge);
    container.appendChild(loadingBadge);
  }

  for (const key of keys) {
    try {
      const issueData = await fetchIssueDeduped(key);
      const state = ROW_STATE.get(row);
      if (!state || state.version !== version || !row.isConnected) {
        return;
      }

      const loadingBadge = loadingBadges.get(key);
      if (loadingBadge && loadingBadge.parentElement === container) {
        container.replaceChild(buildBadge(issueData), loadingBadge);
      }
    } catch (err) {
      // Extension context kan invalide raken bij reload; negeer stil.
    }
  }
}

function getOrCreateHeaderContainer(subjectHeader) {
  let container = document.querySelector('.jira-badge-container--header[data-jira-kind="header"]');

  if (container && container.previousElementSibling !== subjectHeader) {
    container.remove();
    container = null;
  }

  if (container) return container;

  container = document.createElement("span");
  container.className = "jira-badge-container jira-badge-container--header";
  container.setAttribute("data-jira-kind", "header");
  subjectHeader.insertAdjacentElement("afterend", container);
  return container;
}

function removeHeaderContainer() {
  const container = document.querySelector('.jira-badge-container--header[data-jira-kind="header"]');
  if (container) {
    container.remove();
  }
}

async function processOpenedEmailHeader() {
  const subjectHeader = document.querySelector(HEADER_SELECTOR);
  if (!subjectHeader) {
    headerFingerprint = "";
    removeHeaderContainer();
    return;
  }

  const subjectText = subjectHeader.textContent || "";
  const keys = extractKeys(subjectText);
  const fingerprint = `${subjectText.slice(0, 250)}|${keys.join(",")}`;

  if (fingerprint === headerFingerprint) {
    return;
  }

  headerFingerprint = fingerprint;
  headerRequestVersion += 1;
  const activeVersion = headerRequestVersion;

  if (keys.length === 0) {
    removeHeaderContainer();
    return;
  }

  const container = getOrCreateHeaderContainer(subjectHeader);
  container.textContent = "";

  const loadingBadges = new Map();
  for (const key of keys) {
    const loadingBadge = buildLoadingBadge(key);
    loadingBadges.set(key, loadingBadge);
    container.appendChild(loadingBadge);
  }

  for (const key of keys) {
    try {
      const issueData = await fetchIssueDeduped(key);
      if (activeVersion !== headerRequestVersion) return;

      const loadingBadge = loadingBadges.get(key);
      if (loadingBadge && loadingBadge.parentElement === container) {
        container.replaceChild(buildBadge(issueData), loadingBadge);
      }
    } catch (err) {
      // Extension context kan invalide raken bij reload; negeer stil.
    }
  }
}

function queueAllRows() {
  document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
    pendingRows.add(row);
  });
}

function scheduleFlush() {
  if (scheduledFlush) return;

  scheduledFlush = setTimeout(() => {
    scheduledFlush = null;

    if (window.location.href !== lastLocationHref) {
      lastLocationHref = window.location.href;
      queueAllRows();
      headerDirty = true;
    }

    const rows = Array.from(pendingRows);
    pendingRows.clear();
    rows.forEach((row) => {
      processRow(row).catch(() => {});
    });

    if (headerDirty) {
      headerDirty = false;
      processOpenedEmailHeader().catch(() => {});
    }
  }, SCAN_DEBOUNCE_MS);
}

function handleMutations(mutations) {
  for (const mutation of mutations) {
    if (mutation.target instanceof Element) {
      queueRow(mutation.target);
      if (mutation.target.closest(HEADER_SELECTOR) || mutation.target.matches(HEADER_SELECTOR)) {
        headerDirty = true;
      }
    }

    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      queueRow(node);
      node.querySelectorAll?.(ROW_SELECTOR).forEach((row) => pendingRows.add(row));

      if (node.matches(HEADER_SELECTOR) || node.querySelector?.(HEADER_SELECTOR)) {
        headerDirty = true;
      }
    }
  }

  scheduleFlush();
}

const observer = new MutationObserver(handleMutations);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

queueAllRows();
headerDirty = true;
scheduleFlush();
