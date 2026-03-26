 
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { Readable } from "stream";

const app = express();
app.use(cors());
app.disable("x-powered-by");

// Home route (so Render does not return Forbidden)
app.get("/", (req, res) => {
  res.send("✅ HLS Proxy with Playlist Rewriting (Render.com)");
});

// ✅ Helper to rewrite all playlist URLs
function rewritePlaylist(body, playlistUrl, baseProxy) {
  const lines = body.split(/\r?\n/);
  const out = [];

  for (let line of lines) {
    const trimmed = line.trim();

    // Keep empty lines
    if (!trimmed) {
      out.push(line);
      continue;
    }

    // ✅ Rewrite URI="..." inside tags (for KEY, MAP)
    if (trimmed.startsWith("#")) {
      line = line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absolute = new URL(uri, playlistUrl).toString();
        return `URI="${baseProxy}?url=${encodeURIComponent(absolute)}"`;
      });

      out.push(line);
      continue;
    }

    // ✅ Rewrite segment + sub-playlist lines
    const absoluteUrl = new URL(trimmed, playlistUrl).toString();
    const proxied = `${baseProxy}?url=${encodeURIComponent(absoluteUrl)}`;
    out.push(proxied);
  }

  return out.join("\n");
}

// ✅ Streaming helper for WHATWG Fetch → Node Readable Stream
async function streamToNodeReadable(webStream, res) {
  const reader = webStream.getReader();

  const nodeStream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) return this.push(null);
      this.push(Buffer.from(value));
    }
  });

  nodeStream.pipe(res);
}

// ✅ Proxy endpoint
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: "Missing ?url=" });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"],
        "Range": req.headers["range"] || undefined,
        "Accept": req.headers["accept"] || "*/*",
        "Referer": req.headers["referer"] || ""
      }
    });

    // Forward essential CORS + HLS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");

    const contentType = upstream.headers.get("content-type") || "";

    // ✅ Playlist rewriting
    if (contentType.includes("mpegurl") || target.toLowerCase().endsWith(".m3u8")) {
      const text = await upstream.text();

      const rewritten = rewritePlaylist(
        text,
        target,
        `${req.protocol}://${req.get("host")}/proxy`
      );

      res.set("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // ✅ Segment / binary streaming (TS, MP4, M4S, etc.)
    res.set("Content-Type", contentType || "application/octet-stream");
    return streamToNodeReadable(upstream.body, res);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Upstream fetch failed", detail: err.toString() });
  }
});

// ✅ Bind to Render's PORT
app.listen(process.env.PORT || 8080, () => {
  console.log("✅ HLS Proxy with rewriting running on Render.com");
});
``
