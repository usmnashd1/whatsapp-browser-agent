const TRACKING = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

export function decodeHtml(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === "#") {
        const hex = entity[1]?.toLowerCase() === "x";
        const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) ? String.fromCodePoint(point) : " ";
      }
      return entities[entity.toLowerCase()] ?? " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : " ";
    }
    return entities[entity.toLowerCase()] ?? " ";
  });
}

export function selectReadableHtml(html) {
  const source = String(html || "");
  const article = source.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  return article || main || body || source;
}

export function extractReadableText(html) {
  let source = selectReadableHtml(html);

  source = source
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(div|section|aside)\b[^>]*(?:id|class)=["'][^"']*(?:cookie|consent|gdpr|privacy-banner|newsletter|subscribe|social-share|advertisement|\bads?\b)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|blockquote|tr|table)>/gi, "\n\n")
    .replace(/<(?:h[1-6]|p|div|section|article|blockquote|tr|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(source)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line && line !== lines[index - 1])
    .join("\n\n")
    .trim();
}

export function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw)) return `https://${raw}`;
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function assertSafeUrl(value) {
  const normalized = normalizeUrl(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Invalid URL provided.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http: and https: links can be browsed.");
  const host = parsed.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private or local network targets are blocked.");
  }
  return parsed.toString();
}

function result(url, title, snippet, source) {
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return null;
  return { url: cleanUrl, title: decodeHtml(title || "Untitled"), snippet: decodeHtml(snippet || "").slice(0, 240), source };
}

export function parseDuckDuckGo(html, limit = 8) {
  const matches = [...String(html || "").matchAll(/<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const results = [];
  for (const match of matches) {
    let target = match[1];
    const uddg = target.match(/[?&]uddg=([^&]+)/i);
    if (uddg) target = decodeURIComponent(uddg[1]);
    const normalized = result(target, match[2], match[2], "duckduckgo");
    if (normalized && !results.some((entry) => entry.url === normalized.url)) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export function parseDuckDuckGoApi(body, limit = 8) {
  const results = [];
  const add = (candidate, source) => {
    if (!candidate?.FirstURL) return;
    const normalized = result(candidate.FirstURL, candidate.Text, candidate.Text, source);
    if (normalized && !results.some((entry) => entry.url === normalized.url)) results.push(normalized);
  };
  if (body?.AbstractURL) {
    const primary = result(body.AbstractURL, body.Heading || body.AbstractSource, body.AbstractText, "duckduckgo_abstract");
    if (primary) results.push(primary);
  }
  for (const topic of body?.RelatedTopics || []) {
    if (topic.Topics?.length) {
      for (const nested of topic.Topics) add(nested, "duckduckgo_topics");
    } else {
      add(topic, "duckduckgo_topics");
    }
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

export function parseWikipediaApi(body, limit = 8) {
  return (body?.query?.search || []).map((item) => result(
    `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title || "").replace(/ /g, "_"))}`,
    item.title,
    item.snippet,
    "wikipedia_api",
  )).filter(Boolean).slice(0, limit);
}

async function braveSearch(apiKey, query, limit) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": apiKey } });
  if (!response.ok) throw new Error(`Brave Search returned ${response.status}`);
  const body = await response.json();
  return (body?.web?.results || []).map((item) => result(item.url, item.title, item.description, "brave")).filter(Boolean).slice(0, limit);
}

export async function searchWeb(query, braveKey, searchLimit = 8) {
  const clean = String(query || "").trim().slice(0, 300);
  if (!clean) throw new Error("Search words are required.");
  const limit = Math.max(1, Math.min(Number(searchLimit || 8), 15));
  if (braveKey) return braveSearch(braveKey, clean, limit);

  const [webResponse, instantResponse, wikipediaResponse] = await Promise.all([
    fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, {
      headers: { "user-agent": "Mozilla/5.0 ResearchNavigator/1.0", accept: "text/html" },
    }).catch(() => null),
    fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_html=1&no_redirect=1&skip_disambig=0`, {
      headers: { accept: "application/json" },
    }).catch(() => null),
    fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(clean)}&utf8=1&format=json&origin=*`, {
      headers: { accept: "application/json", "user-agent": "WhatsAppResearchBrowser/0.1 (Research assistant)" },
    }).catch(() => null),
  ]);
  const candidates = [];
  if (webResponse?.ok) candidates.push(...parseDuckDuckGo(await webResponse.text(), limit));
  if (instantResponse?.ok) candidates.push(...parseDuckDuckGoApi(await instantResponse.json().catch(() => null), limit));
  if (wikipediaResponse?.ok) candidates.push(...parseWikipediaApi(await wikipediaResponse.json().catch(() => null), limit));
  const unique = [];
  for (const item of candidates) {
    if (!unique.some((entry) => entry.url === item.url)) unique.push(item);
    if (unique.length >= limit) break;
  }
  if (!unique.length) throw new Error("No search results were returned. Add BRAVE_SEARCH_API_KEY for full web search.");
  return unique;
}

export function parseRenderedLinks(html, baseUrl, limit = 60) {
  const byUrl = new Map();
  const anchors = String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    const attributes = match[1] || "";
    const href = attributes.match(/\bhref\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/i);
    if (!href) continue;
    try {
      const safe = assertSafeUrl(new URL(decodeHtml(href[1] || href[2]), baseUrl).toString());
      const target = new URL(safe);
      const labelled = attributes.match(/\b(?:aria-label|title)\s*=\s*["']([^"']+)["']/i)?.[1] || "";
      const pathTitle = decodeURIComponent(target.pathname.split("/").filter(Boolean).pop() || "")
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      const title = decodeHtml(match[2]) || decodeHtml(labelled) || pathTitle || target.hostname;
      const candidate = { url: safe, title: title.slice(0, 140), hostname: target.hostname };
      const existing = byUrl.get(safe);
      if (!existing || candidate.title.length > existing.title.length) byUrl.set(safe, candidate);
    } catch {}
    if (byUrl.size >= limit) break;
  }
  return [...byUrl.values()];
}
