import express from "express";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// yt-dlp バイナリの絶対パス (環境変数で上書き可能)
const YTDLP_PATH = process.env.YTDLP_PATH || path.join(__dirname, "yt-dlp");

// ==============================
// キャッシュ
// ==============================
const videoCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 3;

/**
 * yt-dlp を実行してストリームURLを取得
 */
function getVideoUrls(videoId, format, cookieFile = null) {
  const cookieArg = cookieFile ? `--cookies ${cookieFile}` : "";
  const cmd = [
    YTDLP_PATH,
    cookieArg,
    "--js-runtimes node",
    "--remote-components ejs:github",
    "--sleep-requests 0.5",
    "--user-agent",
    '"Mozilla/5.0 (compatible; K-tube/2.0)"',
    "--get-url",
    "-f",
    `"${format}"`,
    `https://youtu.be/${videoId}`
  ].filter(Boolean).join(" "); // cookieArg が空文字でも問題ないように filter

  try {
    const output = execSync(cmd, {
      timeout: 15000,
      encoding: "utf-8",
    }).trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl;

    if (!videoUrl) throw new Error("No URL extracted");

    return {
      video: videoUrl,
      audio: audioUrl,
      source: "yt-dlp",
    };
  } catch (e) {
    throw new Error(`yt-dlp failed: ${e.message}`);
  }
}

// ==============================
// プリセットフォーマット一覧
// ==============================
const FORMAT_PRESETS = {
  best: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
  audio: "bestaudio[ext=m4a]/bestaudio",
  "360p": "best[ext=mp4][height<=360]/best[ext=mp4]",
  "720p": "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]",
  "1080p": "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]",
};

// ==============================
// API エンドポイント
// ==============================
app.get("/api/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: "?id=VIDEO_ID is required" });
  }

  // モード判定
  let mode = req.query.mode || "best";  // デフォルトは最高画質+音声
  let customFormat = req.query.format;  // カスタム指定があれば優先

  if (customFormat) {
    mode = "custom";
  }

  const formatStr = customFormat || FORMAT_PRESETS[mode];
  if (!formatStr) {
    return res.status(400).json({
      error: "Invalid mode",
      availableModes: Object.keys(FORMAT_PRESETS).concat("custom (use format=...)")
    });
  }

  // キャッシュキー
  const cacheKey = `${videoId}::${mode}::${formatStr}`;
  const cached = videoCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`CACHE HIT: ${cacheKey}`);
    return res.json(cached.data);
  }

  // yt-dlp 実行
  try {
    const cookieFile = process.env.COOKIE_FILE || null; // 必要なら環境変数で指定
    const data = getVideoUrls(videoId, formatStr, cookieFile);

    // キャッシュに保存
    videoCache.set(cacheKey, {
      data,
      time: Date.now(),
    });
    console.log(`CACHE SAVE: ${cacheKey}`);

    res.json(data);
  } catch (e) {
    console.error("yt-dlp error:", e.message);
    res.status(500).json({
      error: "failed_to_extract_video",
      message: e.message.includes("Sign in")
        ? "YouTube が認証を要求しています。有効な cookies ファイルを環境変数 COOKIE_FILE で指定してください。"
        : e.message,
    });
  }
});

// キャッシュクリア (管理用)
app.get("/api/clear-cache", (req, res) => {
  videoCache.clear();
  res.json({ message: "Cache cleared" });
});

// ヘルスチェック
app.get("/", (req, res) => {
  res.json({
    service: "yt-dlp API",
    endpoints: {
      "/api/video?id=VIDEO_ID&mode=MODE": "動画URL取得",
      modes: Object.keys(FORMAT_PRESETS),
      custom: "format= で任意のフォーマット指定",
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp API running on port ${PORT}`);
});
