import express from "express";
import { execSync } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================
// キャッシュ (メモリ内)
// ==============================
const videoCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3時間

// ==============================
// yt-dlp 実行ヘルパー
// ==============================
/**
 * yt-dlp を実行してストリームURLを取得
 * @param {string} videoId YouTubeの動画ID (watch?v= の後ろ)
 * @param {string} format yt-dlp 用フォーマット指定
 * @param {string} [cookieFile] 任意のcookiesファイルパス
 * @returns {{ video: string, audio: string, source: string }}
 */
function getVideoUrls(videoId, format, cookieFile = null) {
  const cookieArg = cookieFile ? `--cookies ${cookieFile}` : "";
  const cmd = [
    "yt-dlp",
    cookieArg,
    "--js-runtimes node",
    "--remote-components ejs:github",
    "--sleep-requests 0.5",     // 高速化のため短め
    "--user-agent",
    '"Mozilla/5.0 (compatible; K-tube/2.0)"',
    "--get-url",
    "-f",
    `"${format}"`,
    `https://youtu.be/${videoId}`
  ].join(" ");

  try {
    const output = execSync(cmd, {
      timeout: 15000,
      encoding: "utf-8",
    }).trim().split("\n");

    // 音声分離フォーマットなら2行、統合なら1行
    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl; // 同じURLになる場合もある

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
