import express from "express";
import { searchWeb } from "./web.js";
import { renderPage, renderScreenshot, renderPdf, renderLinks } from "./browser.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WHATSAPP_API_BASE = process.env.WHATSAPP_API_BASE || "https://api.whatsapp.com/agent/v1";
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN || "";
const GATEWAY_SHARED_SECRET = process.env.GATEWAY_SHARED_SECRET || "";
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const OWNER_WA_IDS = (process.env.OWNER_WA_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const PAGE_CHUNK_CHARS = Number(process.env.PAGE_CHUNK_CHARS || 3500);

// In-memory state
const sessions = new Map();
const handledMessages = new Map(); // id -> timestamp
let nextOffset = undefined;
let isPolling = false;

// WhatsApp Helpers
async function waFetch(path, init = {}) {
  const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${WHATSAPP_API_TOKEN}`, ...(init.headers || {}) },
  });
  if (res.status === 204) return { response: res, body: null };
  return { response: res, body: await res.json().catch(() => null) };
}

async function sendWhatsAppText(to, text) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining) {
    let end = Math.min(3900, remaining.length);
    if (end < remaining.length) {
      const boundary = Math.max(remaining.lastIndexOf("\n", end), remaining.lastIndexOf(" ", end));
      if (boundary > 2500) end = boundary;
    }
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  for (const body of chunks.length ? chunks : ["(empty response)"]) {
    const sent = await waFetch("/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!sent.response.ok) {
      console.error(`WhatsApp text send failed ${sent.response.status}:`, sent.body);
    }
  }
}

async function sendWhatsAppMedia(to, buffer, mime, filename, caption) {
  if (buffer.length > 16 * 1024 * 1024) throw new Error("Captured file exceeds the 16 MB WhatsApp limit.");
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", mime);
  form.set("file", new File([buffer], filename, { type: mime }));
  const uploaded = await waFetch("/media", { method: "POST", body: form });
  if (!uploaded.response.ok || !uploaded.body?.id) {
    throw new Error(`WhatsApp upload ${uploaded.response.status}: ${JSON.stringify(uploaded.body)}`);
  }
  const type = mime.startsWith("image/") ? "image" : "document";
  const media = { id: uploaded.body.id, caption };
  if (type === "document") media.filename = filename;
  const sent = await waFetch("/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type, [type]: media }),
  });
  if (!sent.response.ok) throw new Error(`WhatsApp media send ${sent.response.status}: ${JSON.stringify(sent.body)}`);
}

function allowedSender(sender) {
  return !OWNER_WA_IDS.length || OWNER_WA_IDS.includes(String(sender));
}

function formatResults(query, results) {
  const lines = [`🔍 *Search Results for:* ${query}\n`];
  results.forEach((r, i) => {
    lines.push(`*${i + 1}.* ${r.title}\n${r.snippet}\n${r.url}\n`);
  });
  lines.push("➡️ Send *b1* to read first result, *s1* for screenshot, *p1* for PDF.");
  return lines.join("\n");
}

function formatPageLinks(links) {
  if (!links?.length) return "";
  const subset = links.slice(0, 10);
  const formatted = subset.map((l, i) => `*${i + 1}.* ${l.title} (${l.url})`).join("\n");
  return `\n\n🔗 *Page Links:*\n${formatted}\n\n➡️ Send *b1*..*b${subset.length}* to navigate.`;
}

function selectedUrl(session, input) {
  const matchIndex = input.match(/^[blsp](\d+)$/i);
  if (matchIndex) {
    const idx = parseInt(matchIndex[1], 10) - 1;
    if (session.links && session.links[idx]) {
      return session.links[idx].url;
    }
    throw new Error(`Link #${matchIndex[1]} is not in current search/page list.`);
  }
  const matchUrl = input.match(/^[blsp]\s+(https?:\/\/.+)$/i);
  if (matchUrl) return matchUrl[1];
  throw new Error("Invalid command format. Use e.g. b1 or b https://example.com");
}

function nextPageChunk(session, reset = false) {
  const text = session.pageText || "";
  if (reset) session.offset = 0;
  const start = session.offset || 0;
  const end = Math.min(start + PAGE_CHUNK_CHARS, text.length);
  session.offset = end;
  return { text: text.slice(start, end), more: end < text.length };
}

async function handleCommand(session, raw, to) {
  const input = String(raw || "").trim();
  const lower = input.toLowerCase();

  if (!input || ["help", "menu", "commands"].includes(lower)) {
    return "🌐 *Research Browser (Render)*\n\n*g topic* — web search\n*b1* or *b URL* — read page\n*b more* — continue reading page\n*l1* or *l URL* — list page links\n*s1* or *s URL* — full screenshot\n*p1* or *p URL* — full PDF\n*status* — session state\n*reset* — erase session";
  }

  if (lower === "reset") {
    Object.assign(session, { links: [], pageText: "", currentUrl: "", offset: 0, query: "" });
    return "✅ Research session cleared.";
  }

  if (lower === "status") {
    return `Research Browser is ready.\nResults: ${session.links?.length || 0}\nCurrent page: ${session.currentUrl || "none"}\nStored text: ${session.pageText?.length || 0} characters`;
  }

  const search = input.match(/^(?:g|search|research)\s+(.+)$/i);
  if (search) {
    const results = await searchWeb(search[1], BRAVE_SEARCH_API_KEY);
    session.links = results;
    session.query = search[1].trim();
    return formatResults(session.query, results);
  }

  if (/^b\s+(?:more|next)$/i.test(input)) {
    const part = nextPageChunk(session, false);
    return `${part.text}${part.more ? "\n\n➡️ Send *b more* to continue." : ""}`;
  }

  if (/^b(?:\d+|\s+.+)$/i.test(input)) {
    const url = selectedUrl(session, input);
    const page = await renderPage(url);
    session.currentUrl = page.url;
    session.pageText = page.markdown || "[No readable content found.]";
    session.pageTruncated = Boolean(page.truncated);
    session.links = page.links;
    const part = nextPageChunk(session, true);
    return `🌐 ${page.url}\n\n${part.text}${part.more ? "\n\n➡️ Send *b more* to continue." : page.truncated ? "\n\n⚠️ Page truncated at safety ceiling." : ""}${formatPageLinks(page.links)}`;
  }

  if (/^l(?:\d+|\s+.+)$/i.test(input)) {
    const mapped = await renderLinks(selectedUrl(session, input));
    session.links = mapped.links;
    return mapped.links.length
      ? `🔗 *Links from ${mapped.url}*\n\n${mapped.links.map((item, index) => `${index + 1}. ${item.title}\n${item.url}`).join("\n\n")}\n\nUse *b1*, *s1*, or *p1*.`
      : "No public HTTP(S) links found.";
  }

  if (/^s(?:\d+|\s+.+)$/i.test(input)) {
    const capture = await renderScreenshot(selectedUrl(session, input));
    await sendWhatsAppMedia(to, capture.buffer, "image/png", "research-page.png", capture.url);
    return null;
  }

  if (/^p(?:\d+|\s+.+)$/i.test(input)) {
    const capture = await renderPdf(selectedUrl(session, input));
    await sendWhatsAppMedia(to, capture.buffer, "application/pdf", "research-page.pdf", capture.url);
    return null;
  }

  return "Unknown command. Send *help* for the Research Browser menu.";
}

// Background long-poll loop
async function pollLoop() {
  if (isPolling) return;
  isPolling = true;
  console.log("Starting WhatsApp Agent long-poll loop...");

  while (true) {
    try {
      if (!WHATSAPP_API_TOKEN) {
        console.warn("WHATSAPP_API_TOKEN is not set. Sleeping 10s...");
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      const params = new URLSearchParams({ limit: "50", timeout: "25" });
      if (nextOffset !== undefined) params.set("offset", String(nextOffset));

      const result = await waFetch(`/updates?${params}`);
      if (result.response.status === 204) {
        continue;
      }
      if (!result.response.ok) {
        console.error(`WhatsApp poll error ${result.response.status}:`, result.body);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const entry of result.body?.entry || []) {
        for (const change of entry.changes || []) {
          for (const message of change.value?.messages || []) {
            if (message.type !== "text" || !message.text?.body) continue;
            if (handledMessages.has(message.id)) continue;

            handledMessages.set(message.id, Date.now());

            let session = sessions.get(message.from);
            if (!session) {
              session = { links: [], pageText: "", currentUrl: "", offset: 0, query: "" };
              sessions.set(message.from, session);
            }

            // Mark message read & show typing
            waFetch("/statuses", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                status: "read",
                message_id: message.id,
                typing_indicator: { type: "text" },
              }),
            }).catch(() => null);

            try {
              if (!allowedSender(message.from)) {
                throw new Error("This research agent is private.");
              }
              const reply = await handleCommand(session, message.text.body, message.from);
              if (reply) await sendWhatsAppText(message.from, reply);
            } catch (err) {
              await sendWhatsAppText(message.from, `❌ ${String(err?.message || err).slice(0, 700)}`);
            }
          }
        }
      }

      if (Number.isInteger(result.body?.next_offset)) {
        nextOffset = result.body.next_offset;
      }

      // Cleanup handled message IDs older than 24h
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      for (const [mid, time] of handledMessages.entries()) {
        if (time < dayAgo) handledMessages.delete(mid);
      }
    } catch (err) {
      console.error("Polling loop exception:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Routes
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-research-browser-render" });
});

app.post("/admin/browser-test", async (req, res) => {
  if (GATEWAY_SHARED_SECRET && req.headers.authorization !== `Bearer ${GATEWAY_SHARED_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const page = await renderPage(req.body?.url || "https://example.com");
    res.json({ ok: true, url: page.url, characters: page.markdown.length, preview: page.markdown.slice(0, 500), links: page.links.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Research Browser listening on port ${PORT}`);
  pollLoop();
});
