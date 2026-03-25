const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const archiver = require("archiver");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  exposedHeaders: ["Content-Disposition"],
}));
app.use(express.json({ limit: "10kb" }));

app.use("/api/", rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 20,             // max 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
}));

// Validate that the URL is a proper http/https URL to prevent command injection
function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Cookie args for yt-dlp ───────────────────────────────────────────────────
// Priority: COOKIES_BROWSER env var → cookies.txt file → nothing
function cookieArgs() {
  if (process.env.COOKIES_BROWSER) {
    return ["--cookies-from-browser", process.env.COOKIES_BROWSER];
  }
  const cookiesFile = path.join(__dirname, "cookies.txt");
  if (fs.existsSync(cookiesFile)) {
    return ["--cookies", cookiesFile];
  }
  return [];
}

// ─── Quality helpers ────────────────────────────────────────────────────────────
function buildVideoFormat(quality) {
  const h = parseInt(quality, 10);
  if (h === 720 || h === 1080) return `bestvideo[height<=${h}]+bestaudio/best`;
  return "bestvideo+bestaudio/best"; // 2160 / default = best available
}

function buildAudioQuality(quality) {
  if (quality === "128" || quality === "192" || quality === "320") return `${quality}K`;
  return "0"; // best VBR
}

// ─── Title fetch (metadata only, no download) ────────────────────────────────
app.post("/api/title", (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({ error: "A valid http/https URL is required." });
  }

  const args = [
    url,
    "--simulate",
    "--no-playlist",
    "--no-warnings",
    "--print", "%(title)s",
    ...cookieArgs(),
  ];

  let stdout = "";
  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (c) => { stdout += c; });
  proc.on("close", (code) => {
    if (code !== 0) return res.status(500).json({ error: "Could not fetch title." });
    const title = stdout.trim().split("\n")[0] || "Unknown Title";
    res.json({ title });
  });
});

// ─── Info fetch: title + duration + estimated size ──────────────────────────
app.post("/api/info", (req, res) => {
  const { url, format, quality } = req.body;
  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({ error: "A valid http/https URL is required." });
  }

  const isVideo = format === "video";
  const args = [
    url,
    "-f", isVideo ? buildVideoFormat(quality) : "bestaudio/best",
    "--simulate",
    "--no-playlist",
    "--no-warnings",
    "--print", "%(title)s\n%(duration>%H:%M:%S|0:00)s\n%(filesize,filesize_approx|NA)s",
    ...cookieArgs(),
  ];

  let stdout = "";
  let stderr = "";
  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (c) => { stdout += c; });
  proc.stderr.on("data", (c) => { stderr += c; });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error("yt-dlp info error:", stderr);
      return res.status(500).json({ error: "Could not fetch video info." });
    }
    const lines = stdout.trim().split("\n");
    const title    = lines[0] || "Unknown Title";
    const duration = lines[1] || "—";
    const rawSize  = lines[2] || "NA";
    // Convert bytes → human-readable
    let filesize = null;
    if (rawSize !== "NA" && rawSize !== "None" && !isNaN(Number(rawSize))) {
      const bytes = Number(rawSize);
      if      (bytes >= 1024 * 1024) filesize = (bytes / (1024 * 1024)).toFixed(1) + " MB";
      else if (bytes >= 1024)        filesize = (bytes / 1024).toFixed(0) + " KB";
      else                           filesize = bytes + " B";
    }
    res.json({ title, duration, filesize });
  });
});

app.post("/api/download", (req, res) => {
  const { url, format, quality } = req.body;

  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({ error: "A valid http/https URL is required." });
  }

  const isVideo = format === "video";
  // Generate a unique temp file path
  const tmpDir = os.tmpdir();
  const fileId = crypto.randomBytes(16).toString("hex");
  const outputTemplate = path.join(tmpDir, `${fileId}.%(ext)s`);

  const args = [
    ...(isVideo ? [
      url,
      "-f", buildVideoFormat(quality),
      "--merge-output-format", "mp4",
    ] : [
      url,
      "-f", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", buildAudioQuality(quality),
    ]),
    "--no-playlist",
    "--output", outputTemplate,
    "--no-mtime",
    "--print", "before_dl:FILETITLE:%(title)s",
    "--print", "after_move:FILEPATH:%(filepath)s",
    ...cookieArgs(),
  ];

  let stdoutBuf = "";
  let errorOutput = "";

  const dlProc = spawn("yt-dlp", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  dlProc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
  });

  dlProc.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });

  dlProc.on("close", (code) => {
    // Parse the two marker lines from stdout
    const titleMatch = stdoutBuf.match(/^FILETITLE:(.+)$/m);
    const pathMatch  = stdoutBuf.match(/^FILEPATH:(.+)$/m);
    const resolvedPath = pathMatch ? pathMatch[1].trim() : "";
    const videoTitle  = titleMatch
      ? titleMatch[1].trim().replace(/[^\w\s\-().]/g, "").trim() || "file"
      : "file";

    if (code !== 0 || !resolvedPath || !fs.existsSync(resolvedPath)) {
      console.error("yt-dlp error:", errorOutput);
      return res.status(500).json({
        error: "Failed to download. Make sure the URL is a supported video link.",
      });
    }

    const ext = isVideo ? "mp4" : "mp3";
    const safeFilename = `${videoTitle}.${ext}`;

    res.setHeader("Content-Type", isVideo ? "video/mp4" : "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );

    const fileStream = fs.createReadStream(resolvedPath);

    fileStream.pipe(res);

    fileStream.on("end", () => {
      fs.unlink(resolvedPath, () => {});
    });

    fileStream.on("error", (err) => {
      console.error("Stream error:", err);
      fs.unlink(resolvedPath, () => {});
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream the audio file." });
      }
    });

    res.on("close", () => {
      // Client disconnected early — clean up
      fs.unlink(resolvedPath, () => {});
    });
  });
});

// ─── Batch download → ZIP ────────────────────────────────────────────────────
const BATCH_MAX = 20;     // max URLs per request
const BATCH_CONCURRENCY = 3; // parallel yt-dlp processes

/**
 * Download one URL to a temp file. Resolves with { filePath, title } or
 * rejects with an Error if yt-dlp fails.
 */
function downloadOne(url, format, quality) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const fileId = crypto.randomBytes(16).toString("hex");
    const outputTemplate = path.join(tmpDir, `${fileId}.%(ext)s`);

    const isVideo = format === "video";
    const args = [
      ...(isVideo ? [
        url,
        "-f", buildVideoFormat(quality),
        "--merge-output-format", "mp4",
      ] : [
        url,
        "-f", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", buildAudioQuality(quality),
      ]),
      "--no-playlist",
      "--output", outputTemplate,
      "--no-mtime",
      "--print", "before_dl:FILETITLE:%(title)s",
      "--print", "after_move:FILEPATH:%(filepath)s",
      ...cookieArgs(),
    ];

    let stdoutBuf = "";
    let stderrBuf = "";
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (c) => { stdoutBuf += c; });
    proc.stderr.on("data", (c) => { stderrBuf += c; });
    proc.on("close", (code) => {
      const titleMatch = stdoutBuf.match(/^FILETITLE:(.+)$/m);
      const pathMatch  = stdoutBuf.match(/^FILEPATH:(.+)$/m);
      const filePath   = pathMatch  ? pathMatch[1].trim()  : "";
      const title      = titleMatch ? titleMatch[1].trim().replace(/[^\w\s\-().]/g, "").trim() || "file" : "file";
      const ext        = isVideo ? "mp4" : "mp3";

      if (code !== 0 || !filePath || !fs.existsSync(filePath)) {
        return reject(new Error(`yt-dlp failed for ${url}: ${stderrBuf.slice(-300)}`));
      }
      resolve({ filePath, title, ext });
    });
  });
}

/** Run tasks with at most `limit` running at once */
async function withConcurrency(limit, tasks) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try { results[i] = { ok: true,  value: await tasks[i]() }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

app.post("/api/download/batch", async (req, res) => {
  const { urls, format, quality } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty array of URLs." });
  }
  if (urls.length > BATCH_MAX) {
    return res.status(400).json({ error: `Maximum ${BATCH_MAX} URLs per batch.` });
  }
  const invalid = urls.find((u) => typeof u !== "string" || !isValidUrl(u));
  if (invalid) {
    return res.status(400).json({ error: "All entries must be valid http/https URLs." });
  }

  // Download all in parallel (capped)
  const tasks = urls.map((url) => () => downloadOne(url, format, quality));
  const results = await withConcurrency(BATCH_CONCURRENCY, tasks);

  const succeeded = results.filter((r) => r.ok);
  if (succeeded.length === 0) {
    results.forEach((r) => !r.ok && console.error(r.error?.message));
    return res.status(500).json({ error: "All downloads failed. Check the URLs and try again." });
  }

  // Stream a ZIP back
  const bundleName = format === "video" ? "video-bundle.zip" : "audio-bundle.zip";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(bundleName)}`);

  const archive = archiver("zip", { zlib: { level: 0 } }); // level 0 = store only (MP3s don't compress)
  archive.pipe(res);

  // Deduplicate filenames inside the ZIP
  const seen = new Map();
  for (const r of succeeded) {
    const base = r.value.title;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const entryName = count === 0 ? `${base}.${r.value.ext}` : `${base} (${count}).${r.value.ext}`;
    archive.file(r.value.filePath, { name: entryName });
  }

  archive.on("error", (err) => {
    console.error("Archive error:", err);
    res.end();
  });

  archive.finalize();

  // Clean up temp files once the response is done
  res.on("finish", () => {
    for (const r of succeeded) fs.unlink(r.value.filePath, () => {});
  });
  res.on("close", () => {
    for (const r of succeeded) fs.unlink(r.value.filePath, () => {});
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
