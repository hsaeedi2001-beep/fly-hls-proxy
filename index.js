
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { Readable } from "stream";

/* -----------------------------------------------------------
   CONFIG  (Copied from your Worker version)
----------------------------------------------------------- */

const ALLOW_ORIGIN_REGEX = /^https:\/\/(.+\.)?aparatchi\.com$/;
const ALLOW_METHODS = "GET,HEAD,OPTIONS";
const ALLOW_HEADERS = "Range,Origin,Accept,Cache-Control,Pragma,Referer,User-Agent";
const EXPOSE_HEADERS = "Content-Length,Content-Range,Accept-Ranges";

const DEFAULT_ALLOWED_BASE_DOMAINS = [
  "gg.hls2.xyz",
  "90minlive.online",
  "irib.ir",
];

const DEFAULT_FORCE_REFERER = "https://aparatchi.com";

/* -----------------------------------------------------------
   EXPRESS APP
----------------------------------------------------------- */

const app = express();
app.disable("x-powered-by");

/* -----------------------------------------------------------
   HOME ROUTE (prevents Render "Forbidden")
----------------------------------------------------------- */

app.get("/", (req, res) => {
  res.send("✅ Aparatchi-style HLS Proxy running on Render");
});

/* -----------------------------------------------------------
   HEALTH & DEBUG
----------------------------------------------------------- */

app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/debug", (req, res) => {
  const target = getTargetUrl(req);
  let host = null;
  try { host = target ? new URL(target).hostname : null; } catch {}
  res.json({ target, host });
});

/* -----------------------------------------------------------
   OPTIONS: CORS PREFLIGHT
----------------------------------------------------------- */

app.options("*", (req, res) => {
  applyCors(res, req.get("Origin") || "");
  res.status(204).send();
});

/* -----------------------------------------------------------
   MAIN PROXY ENDPOINT
----------------------------------------------------------- */

app.get("/proxy*", async (req, res) => {
  const origin = req.get("Origin") || "";
  const target = getTargetUrl(req);

  if (!target) {
    applyCors(res, origin);
    return res.status(400).json({ error: "Missing ?url=" });
  }

  // Domain whitelist
  if (!isHostAllowed(target, DEFAULT_ALLOWED_BASE_DOMAINS)) {
    applyCors(res, origin);
    return res.status(403).json({ error: "Target host not allowed", target });
  }

  // Build upstream headers
  const upstreamHeaders = {
    "User-Agent": req.get("User-Agent"),
    "Range": req.get("Range") || undefined,
    "Accept":
      req.get("Accept") ||
      "application/vnd.apple.mpegurl,application/x-mpegurl,video/*;q=0.9,*/*;q=0.8",
    "Cache-Control": req.get("Cache-Control") || undefined,
    "Pragma": req.get("Pragma") || undefined,
    "Referer": DEFAULT_FORCE_REFERER || req.get("Referer") || "",
  };

  console.log("[proxy]", {
    target,
    range: req.get("Range") || null,
    origin
  });

  // Fetch upstream
  let upstream;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    applyCors(res, origin);
    return res.status(502).json({ error: "Upstream fetch failed", detail: err.toString() });
  }

  const upstreamCT = upstream.headers.get("content-type") || "";
  const contentType = normalizeContentType(target, upstreamCT);

  applyCors(res, origin);
  res.set("Content-Type", contentType);

  const isPlaylist = isM3U8(contentType, target);

  /* -----------------------------------------------------------
     PLAYLIST HANDLING + REWRITING
  ----------------------------------------------------------- */
  if (isPlaylist) {
    let text;
    try {
      text = await upstream.text();
    } catch {
      return res.status(502).send("Bad Gateway");
    }

    const proxyBase = `${req.protocol}://${req.get("host")}/proxy`;
    const rewritten = rewritePlaylistText(text, target, proxyBase);

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(rewritten);
  }

  /* -----------------------------------------------------------
     STREAMING SEGMENTS
  ----------------------------------------------------------- */

  return streamReadable(upstream.body, res);
});

/* -----------------------------------------------------------
   PORT for Render
----------------------------------------------------------- */

app.listen(process.env.PORT || 8080, () => {
  console.log("✅ Aparatchi HLS Proxy running on Render");
});

/* -----------------------------------------------------------
   HELPERS — FULL WORKER LOGIC TRANSLATED TO NODE
----------------------------------------------------------- */

function applyCors(res, origin) {
  const allowOrigin =
    origin && ALLOW_ORIGIN_REGEX.test(origin)
      ? origin
      : "https://aparatchi.com";

  res.set({
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Expose-Headers": EXPOSE_HEADERS,
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin",
  });
}

function getTargetUrl(req) {
  const qp = req.query.url;
  if (qp) return safeDecode(qp);

  const path = req.path.split("/").slice(2).join("/");
  if (path) return safeDecode(path);

  return null;
}

/* ✅ FIXED VERSION — Handles URL-encoded + Base64 cleanly */
function safeDecode(raw) {
  if (!raw) return null;

  // URL decode
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch {}

  // Base64 decode
  try {
    const b = Buffer.from(raw, "base64").toString("utf8");
    if (b.startsWith("http://") || b.startsWith("https://")) {
      return b;
    }
  } catch {}

  return raw;
}

function isHostAllowed(targetUrl, list) {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return list.some(base => host === base || host.endsWith("." + base));
  } catch {
    return false;
  }
}

function isM3U8(ct, url) {
  ct = ct.toLowerCase();
  url = url.toLowerCase();
  return ct.includes("mpegurl") || url.endsWith(".m3u8");
}

function normalizeContentType(url, ct) {
  ct = (ct || "").toLowerCase();
  if (ct.includes("mpegurl")) return "application/vnd.apple.mpegurl";
  if (url.toLowerCase().endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (ct.includes("mp2t")) return "video/mp2t";
  if (url.toLowerCase().endsWith(".ts")) return "video/mp2t";
  return ct || "application/octet-stream";
}

/* ✅ Playlist rewriting exactly like your Worker */
function rewritePlaylistText(text, playlistUrl, proxyBase) {
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();

      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = new URL(uri, playlistUrl).toString();
          return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}"`;
        });
      }

      const absolute = new URL(trimmed, playlistUrl).toString();
      return `${proxyBase}?url=${encodeURIComponent(absolute)}`;
    })
    .join("\n");
}

/* ✅ Node-compatible streaming from WHATWG stream */
async function streamReadable(webStream, res) {
  const reader = webStream.getReader();

  const nodeStream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) return this.push(null);
      this.push(Buffer.from(value));
    },
  });

  nodeStream.pipe(res);
}
