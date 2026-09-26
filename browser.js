import puppeteer from "puppeteer";
import { assertSafeUrl, extractReadableText, parseRenderedLinks, selectReadableHtml } from "./web.js";

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    });
  }
  return browserInstance;
}

export async function renderPage(url, maxChars = 120000) {
  const safeUrl = assertSafeUrl(url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.goto(safeUrl, { waitUntil: "networkidle2", timeout: 35000 });
    const html = await page.content();
    const readable = extractReadableText(html);
    const links = parseRenderedLinks(selectReadableHtml(html), safeUrl);
    const limit = Math.max(10000, Math.min(Number(maxChars || 120000), 250000));
    return {
      url: safeUrl,
      markdown: readable.slice(0, limit),
      truncated: readable.length > limit,
      links,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderScreenshot(url) {
  const safeUrl = assertSafeUrl(url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(safeUrl, { waitUntil: "networkidle2", timeout: 35000 });
    const buffer = await page.screenshot({ fullPage: true, type: "png" });
    return { url: safeUrl, buffer };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderPdf(url) {
  const safeUrl = assertSafeUrl(url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(safeUrl, { waitUntil: "networkidle2", timeout: 35000 });
    const buffer = await page.pdf({ format: "A4", printBackground: true });
    return { url: safeUrl, buffer };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderLinks(url) {
  const safeUrl = assertSafeUrl(url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(safeUrl, { waitUntil: "networkidle2", timeout: 35000 });
    const html = await page.content();
    const links = parseRenderedLinks(html, safeUrl);
    return { url: safeUrl, links };
  } finally {
    await page.close().catch(() => {});
  }
}
