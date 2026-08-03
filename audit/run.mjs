/**
 * run.mjs — the audit engine behind tangled-design.ro/audit.
 *
 * Reads AUDIT_ID + AUDIT_URL from the environment (set by the workflow
 * from the dispatch payload — env indirection, never shell-interpolated),
 * loads the page in headless Chrome, runs axe-core with the WCAG tag set
 * that EN 301 549 / the Romanian laws point to, and writes a public JSON
 * report to ../reports/<id>.json.
 *
 * Design rules baked in (the parked-domain lesson):
 *   - The report ALWAYS records finalUrl + pageTitle, so the reader can
 *     verify WHAT was actually tested — a score without identity is noise.
 *   - Failures still produce a report (status: "error") so the site's
 *     polling page can show an honest message instead of spinning.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import puppeteer from "puppeteer";
import { AxePuppeteer } from "@axe-core/puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, "..", "reports");

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const id = process.env.AUDIT_ID ?? "";
const rawUrl = process.env.AUDIT_URL ?? "";

function writeReport(report) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = resolve(REPORTS_DIR, `${id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`report written: reports/${id}.json (status: ${report.status})`);
}

function errorReport(errorCode, extra = {}) {
  return {
    version: 1,
    id,
    status: "error",
    errorCode,
    requestedUrl: rawUrl,
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

// ─── Input validation ──────────────────────────────────────────────────────

if (!/^[a-f0-9]{16,64}$/.test(id)) {
  console.error("invalid audit id, refusing");
  process.exit(1); // no id → nowhere safe to write a report
}

let target;
try {
  target = new URL(rawUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
} catch {
  writeReport(errorReport("invalid-url"));
  process.exit(0);
}

function isPrivateAddress(addr) {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = addr.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

const host = target.hostname;
if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
  writeReport(errorReport("private-address-blocked"));
  process.exit(0);
}
let addrs;
try {
  addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
} catch {
  writeReport(errorReport("dns-failed"));
  process.exit(0);
}
if (addrs.some((a) => isPrivateAddress(a.address))) {
  writeReport(errorReport("private-address-blocked"));
  process.exit(0);
}

// ─── Load the page ─────────────────────────────────────────────────────────

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // Audit under prefers-reduced-motion: assistive-technology users
  // commonly run with it, well-built sites render their final state
  // instantly, and it prevents axe from catching entrance animations
  // mid-tween (headless Chrome throttles rAF, freezing tweens at
  // near-zero opacity — a false contrast violation).
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  const ua = await browser.userAgent();
  await page.setUserAgent(
    `${ua} TangledAuditBot/1.0 (+https://tangled-design.ro/audit)`
  );

  let responseStatus = null;
  try {
    const resp = await page.goto(target.href, {
      waitUntil: "networkidle2",
      timeout: 45_000,
    });
    responseStatus = resp?.status() ?? null;
  } catch {
    // Slow sites: settle for DOM-ready before giving up entirely.
    try {
      await page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      writeReport(errorReport("navigation-timeout"));
      process.exit(0);
    }
  }

  await new Promise((r) => setTimeout(r, 2_000));

  // Walk the page to the bottom and back so scroll-triggered reveal
  // animations complete before the audit — otherwise below-the-fold
  // text is captured mid-reveal (near-zero opacity) and reports as a
  // false color-contrast violation. Real visitors always scroll.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.7;
    const max = Math.min(document.body.scrollHeight, 60_000);
    for (let y = 0; y <= max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await new Promise((r) => setTimeout(r, 1_200));

  const finalUrl = page.url();
  const pageTitle = (await page.title().catch(() => "")) || "";

  // Anti-bot / interstitial detection — a challenge page would otherwise
  // produce a falsely reassuring "0 violations" report about a page the
  // user never asked us to test (caught by external QA on a Cloudflare
  // "One moment, please..." interstitial).
  const challengeTitle =
    /one moment|just a moment|attention required|access denied|checking your browser|verific|ddos|captcha/i.test(
      pageTitle
    );
  const challengeDom = await page
    .evaluate(() => {
      const sel = [
        "#challenge-running",
        "#challenge-form",
        "#cf-challenge-running",
        'script[src*="challenge-platform"]',
        'form[action*="__cf_chl"]',
        "#captcha",
        ".g-recaptcha",
        "#px-captcha",
      ];
      return sel.some((q) => document.querySelector(q) !== null);
    })
    .catch(() => false);
  if (
    challengeTitle ||
    challengeDom ||
    responseStatus === 403 ||
    responseStatus === 503 ||
    responseStatus === 429
  ) {
    writeReport(
      errorReport("blocked-or-interstitial", {
        finalUrl,
        pageTitle: pageTitle.slice(0, 300),
        httpStatus: responseStatus,
      })
    );
    process.exit(0);
  }
  const htmlLang = await page
    .$eval("html", (el) => el.getAttribute("lang"))
    .catch(() => null);

  const results = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();

  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? "minor",
    help: v.help,
    description: v.description,
    helpUrl: v.helpUrl,
    wcagTags: v.tags.filter((t) => /^wcag\d/.test(t)),
    nodes: v.nodes.length,
    sampleTargets: v.nodes
      .slice(0, 50)
      .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)).slice(0, 140)),
    samples: v.nodes.slice(0, 50).map((n) => ({
      target: (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)).slice(0, 140),
      note: (n.failureSummary ?? "").replace(/^Fix any of the following:\s*/i, "").slice(0, 300),
    })),
  }));

  const incompleteChecks = results.incomplete.map((v) => ({
    id: v.id,
    impact: v.impact ?? "minor",
    help: v.help,
    helpUrl: v.helpUrl,
    wcagTags: v.tags.filter((t) => /^wcag\d/.test(t)),
    nodes: v.nodes.length,
    samples: v.nodes.slice(0, 10).map((n) => ({
      target: (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)).slice(0, 140),
      note: (n.failureSummary ?? "").slice(0, 300),
    })),
  }));

  writeReport({
    version: 2,
    id,
    status: "done",
    requestedUrl: rawUrl,
    finalUrl,
    pageTitle: pageTitle.slice(0, 300),
    htmlLang,
    fetchedAt: new Date().toISOString(),
    engine: {
      axeCore: results.testEngine?.version ?? "unknown",
      tags: WCAG_TAGS,
      viewport: "1440x900",
    },
    counts: {
      violations: violations.length,
      violationNodes: violations.reduce((s, v) => s + v.nodes, 0),
      passes: results.passes.length,
      incomplete: results.incomplete.length,
      inapplicable: results.inapplicable.length,
    },
    violations,
    incompleteChecks,
  });
} catch (err) {
  console.error("audit crash:", err);
  writeReport(errorReport("crash"));
} finally {
  await browser.close();
}
