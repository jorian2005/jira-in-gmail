const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function readJson(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function collectAttrValues(html, attrName) {
  const pattern = new RegExp(`${attrName}="([^"]+)"`, "g");
  const values = new Set();
  let match;

  while ((match = pattern.exec(html))) {
    values.add(match[1]);
  }

  return values;
}

test("manifest uses MV3 and declares expected pages/scripts", () => {
  const manifest = readJson("manifest.json");

  assert.equal(manifest.manifest_version, 3);
  assert.ok(Array.isArray(manifest.content_scripts));
  assert.ok(manifest.content_scripts.length >= 2);
  assert.equal(typeof manifest.background?.service_worker, "string");
  assert.equal(typeof manifest.options_page, "string");

  const allScriptFiles = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(allScriptFiles.includes("content.js"));
  assert.ok(allScriptFiles.includes("calendar-content.js"));
});

test("manifest referenced files exist", () => {
  const manifest = readJson("manifest.json");

  const mustExist = new Set([
    manifest.background?.service_worker,
    manifest.options_page,
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...(manifest.icons ? Object.values(manifest.icons) : [])
  ]);

  for (const relativePath of mustExist) {
    assert.ok(relativePath, "Found empty file reference in manifest");
    const fullPath = path.join(ROOT, relativePath);
    assert.ok(fs.existsSync(fullPath), `Missing referenced file: ${relativePath}`);
  }
});

test("Jira key regex is consistent across core scripts", () => {
  const background = readText("background.js");
  const gmail = readText("content.js");
  const calendar = readText("calendar-content.js");

  assert.match(background, /const KEY_REGEX = \/\^\[A-Z\]\{2,3\}-\\d\+\$\/;/);
  assert.match(gmail, /const JIRA_KEY_REGEX = \/\\b\[A-Z\]\{2,3\}-\\d\+\\b\/g;/);
  assert.match(calendar, /const JIRA_KEY_REGEX = \/\\b\[A-Z\]\{2,3\}-\\d\+\\b\/g;/);
});

test("locale message keys are in sync between en and nl", () => {
  const en = readJson("_locales/en/messages.json");
  const nl = readJson("_locales/nl/messages.json");

  const enKeys = Object.keys(en).sort();
  const nlKeys = Object.keys(nl).sort();

  assert.deepEqual(nlKeys, enKeys);
});

test("options page i18n attributes reference existing locale keys", () => {
  const en = readJson("_locales/en/messages.json");
  const nl = readJson("_locales/nl/messages.json");
  const html = readText("options.html");

  const i18nKeys = collectAttrValues(html, "data-i18n");
  const i18nPlaceholderKeys = collectAttrValues(html, "data-i18n-placeholder");
  const allKeys = new Set([...i18nKeys, ...i18nPlaceholderKeys]);

  assert.ok(allKeys.size > 0, "Expected at least one i18n key in options.html");

  for (const key of allKeys) {
    assert.ok(en[key], `Missing key in _locales/en/messages.json: ${key}`);
    assert.ok(nl[key], `Missing key in _locales/nl/messages.json: ${key}`);
  }
});

test("README title reflects current project naming", () => {
  const readme = readText("README.md");
  assert.match(readme, /^# Jira Mail & Calendar Badges \(Chrome Extension\)/m);
});

