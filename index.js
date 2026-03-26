
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.disable("x-powered-by");

// Basic proxy endpoint
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"],
        "Range": req.headers["range"] || undefined,
        "Accept": req.headers["accept"] || "*/*",
        "Referer": req.headers["referer"] || ""
      }
    });

    // Forward CORS + essential HLS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.set("Content-Type", ct);

    // Stream response
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.toString() });
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Proxy running on Fly.io");
});
