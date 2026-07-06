// Injects a Jira status section into opened Google Calendar event details.

const JIRA_KEY_REGEX = /\b[A-Z]{2,3}-\d+\b/g;
const MAX_BADGES_PER_EVENT = 3;
const SCAN_DEBOUNCE_MS = 160;

const ISSUE_IN_FLIGHT = new Map();
const ROOT_STATE = new WeakMap();

const STATUS_COLORS = {
  "to do": "#DFE1E6",
  "in progress": "#0052CC",
  done: "#00875A",
  default: "#6B778C"
};

let scheduledScan = null;

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
  return Array.from(new Set(matches)).slice(0, MAX_BADGES_PER_EVENT);
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

function getEventText(root) {
  const titleNode = root.querySelector('[role="heading"]');
  const descriptionNodes = root.querySelectorAll(
    '[data-event-note], [aria-label*="Description" i], [aria-label*="Beschrijving" i], [data-keyboardactiontype="5"], [data-keyboardactiontype="7"]'
  );

  const titleText = titleNode?.textContent || "";
  const descriptionText = Array.from(descriptionNodes)
    .map((node) => node.textContent || "")
    .join("\n");

  return [titleText, descriptionText]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function removeSection(root) {
  const section = root.querySelector('.jira-calendar-section[data-jira-kind="calendar"]');
  if (section) {
    section.remove();
  }
}

function getInsertAnchor(root) {
  const heading = root.querySelector('[role="heading"]');
  if (heading) {
    return heading.closest("div") || heading;
  }

  return root.firstElementChild;
}

function getOrCreateSection(root) {
  let section = root.querySelector('.jira-calendar-section[data-jira-kind="calendar"]');
  if (section) {
    return section;
  }

  section = document.createElement("section");
  section.className = "jira-calendar-section";
  section.setAttribute("data-jira-kind", "calendar");

  const title = document.createElement("div");
  title.className = "jira-calendar-section__title";
  title.textContent = t("calendarSectionTitle", null, "Jira");

  const badgeContainer = document.createElement("div");
  badgeContainer.className = "jira-badge-container jira-calendar-section__badges";

  section.appendChild(title);
  section.appendChild(badgeContainer);

  const anchor = getInsertAnchor(root);
  if (anchor) {
    anchor.insertAdjacentElement("afterend", section);
  } else {
    root.prepend(section);
  }

  return section;
}

function isVisible(root) {
  return root.isConnected && root.getClientRects().length > 0;
}

function collectEventRoots() {
  const roots = new Set();

  document.querySelectorAll('[role="dialog"]').forEach((dialog) => {
    if (isVisible(dialog)) {
      roots.add(dialog);
    }
  });

  const path = window.location.pathname || "";
  if (path.includes("eventedit") || path.includes("event")) {
    const main = document.querySelector('main[role="main"], [role="main"]');
    if (main && isVisible(main)) {
      roots.add(main);
    }
  }

  return Array.from(roots);
}

async function processEventRoot(root) {
  if (!isVisible(root)) return;

  const eventText = getEventText(root);
  const keys = extractKeys(eventText);
  const fingerprint = `${keys.join(",")}|${eventText.slice(0, 300)}`;

  const previous = ROOT_STATE.get(root);
  if (previous && previous.fingerprint === fingerprint) {
    return;
  }

  const version = (previous?.version || 0) + 1;
  ROOT_STATE.set(root, { fingerprint, version });

  if (keys.length === 0) {
    removeSection(root);
    return;
  }

  const section = getOrCreateSection(root);
  const badgeContainer = section.querySelector(".jira-calendar-section__badges");
  if (!badgeContainer) return;

  badgeContainer.textContent = "";
  const loadingBadges = new Map();

  for (const key of keys) {
    const loadingBadge = buildLoadingBadge(key);
    loadingBadges.set(key, loadingBadge);
    badgeContainer.appendChild(loadingBadge);
  }

  for (const key of keys) {
    try {
      const issueData = await fetchIssueDeduped(key);
      const state = ROOT_STATE.get(root);
      if (!state || state.version !== version || !isVisible(root)) {
        return;
      }

      const loadingBadge = loadingBadges.get(key);
      if (loadingBadge && loadingBadge.parentElement === badgeContainer) {
        badgeContainer.replaceChild(buildBadge(issueData), loadingBadge);
      }
    } catch (err) {
      // Ignore temporary extension context resets.
    }
  }
}

function scanCalendarView() {
  const roots = collectEventRoots();
  roots.forEach((root) => {
    processEventRoot(root).catch(() => {});
  });
}

function scheduleScan() {
  if (scheduledScan) return;
  scheduledScan = setTimeout(() => {
    scheduledScan = null;
    scanCalendarView();
  }, SCAN_DEBOUNCE_MS);
}

const observer = new MutationObserver(() => {
  scheduleScan();
});

observer.observe(document.body, { childList: true, subtree: true, characterData: true });
scheduleScan();

