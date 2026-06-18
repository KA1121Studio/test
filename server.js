import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { execSync, chmodSync } from "child_process";
import fs from "fs";

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// yt-dlp バイナリの絶対パスを固定（Render のビルドでダウンロードしたものを使用）
const YTDLP_PATH = path.join(__dirname, "yt-dlp");

// 初回だけ実行権限を保証（万が一の場合）
try { chmodSync(YTDLP_PATH, 0o755); } catch (e) {}

// 静的ファイル配信
app.use(express.static(__dirname));

// ====================== 以下、元のコードをほぼそのまま ======================
let totalAccesses = 0;
let todayAccesses = 0;
let todayDate = new Date().toISOString().split('T')[0];
let activeUsers = new Map();
const ONLINE_TIMEOUT = 5 * 60 * 1000;

const videoCache = new Map();
const CACHE_TIME = 1000 * 60 * 60 * 3;

// ...（updateTodayCount, incrementAccesses などは変更なし）...

// ★★★ /video エンドポイント ★★★
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  const cached = videoCache.get("video_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT:", videoId);
    return res.json(cached.data);
  }

  try {
    // コマンドを配列で構築（バイナリパス + 引数）
    const cmd = [
      YTDLP_PATH,
      "--cookies", "youtube-cookies.txt",
      "--socket-timeout", "30",                // ← 追加
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      "--sleep-requests", "1",
      "--user-agent", "Mozilla/5.0",
      "--get-url",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]",
      `https://youtu.be/${videoId}`
    ].join(" ");

    const output = execSync(cmd, {
      timeout: 60000,      // 60秒に延長（元は15秒）
      encoding: "utf-8"
    }).trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl;

    if (!videoUrl) throw new Error("No valid stream URL extracted. Cookies may be expired.");

    const data = { video: videoUrl, audio: audioUrl, source: "yt-dlp" };
    videoCache.set("video_" + videoId, { data, time: Date.now() });
    console.log("CACHE SAVE:", videoId);
    res.json(data);
  } catch (e) {
    console.error("yt-dlp error:", e.message);
    res.status(500).json({
      error: "failed_to_extract_video",
      message: e.message.includes("Sign in")
        ? "YouTubeがボット判定しました。youtube-cookies.txtを最新のものに更新してください"
        : e.message
    });
  }
});

// ★★★ /video360 エンドポイント ★★★
app.get("/video360", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  const cached = videoCache.get("video360_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT 360:", videoId);
    return res.json(cached.data);
  }

  try {
    const cmd = [
      YTDLP_PATH,
      "--cookies", "youtube-cookies.txt",
      "--socket-timeout", "30",                // ← 追加
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      "--sleep-requests", "1",
      "--user-agent", "Mozilla/5.0",
      "--get-url",
      "-f", "best[ext=mp4][height<=360]/best[ext=mp4]/best",
      `https://youtu.be/${videoId}`
    ].join(" ");

    const output = execSync(cmd, {
      timeout: 60000,
      encoding: "utf-8"
    }).trim();

    if (!output) throw new Error("No valid 360p stream");

    const data = { video: output, audio: output, source: "yt-dlp-360p-progressive" };
    videoCache.set("video360_" + videoId, { data, time: Date.now() });
    console.log("CACHE SAVE 360:", videoId);
    res.json(data);
  } catch (e) {
    console.error("yt-dlp 360p error:", e.message);
    res.status(500).json({ error: "failed_to_extract_video_360", message: e.message });
  }
});

// ...（他のエンドポイントはすべてそのまま）...

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
