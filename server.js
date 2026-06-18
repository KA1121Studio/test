import express from "express";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------------------------
// yt-dlp バイナリのパス
// ----------------------------------------------
const YTDLP = path.join(__dirname, "yt-dlp");
if (fs.existsSync(YTDLP)) {
  fs.chmodSync(YTDLP, 0o755);  // 実行権限を保証
}

// ----------------------------------------------
// キャッシュ
// ----------------------------------------------
const videoCache = new Map();
const CACHE_TIME = 1000 * 60 * 60 * 3; // 3時間（必要に応じて24時間に延ばしてもOK）

// ----------------------------------------------
// ヘルスチェック
// ----------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", endpoints: ["/video?id=...", "/video360?id=..."] });
});

// ----------------------------------------------
// 【モード1】最高画質（映像MP4 + 音声M4A）軽量版
// ----------------------------------------------
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  // キャッシュ確認
  const cached = videoCache.get("video_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT:", videoId);
    return res.json(cached.data);
  }

  try {
    // 軽量オプション追加
    const cmd = `${YTDLP} --no-playlist --no-check-certificate --no-cache-dir --socket-timeout 10 --sleep-requests 0.5 --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0" --get-url -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" https://youtu.be/${videoId}`;

    const output = execSync(cmd, {
      // timeout: 60000,  ← 必要に応じて有効化
    }).toString().trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl;

    if (!videoUrl) {
      throw new Error("No valid stream URL extracted. Cookies may be expired.");
    }

    const data = {
      video: videoUrl,
      audio: audioUrl,
      source: "yt-dlp"
    };

    videoCache.set("video_" + videoId, { data, time: Date.now() });
    console.log("CACHE SAVE:", videoId);
    res.json(data);

  } catch (e) {
    console.error("yt-dlp error:", e.message, e.stack);
    res.status(500).json({
      error: "failed_to_extract_video",
      message: e.message.includes("Sign in")
        ? "YouTubeがボット判定しました。youtube-cookies.txtを最新のものに更新してください"
        : e.message
    });
  }
});

// ----------------------------------------------
// 【モード2】360p プログレッシブ（映像+音声一体化）軽量版
// ----------------------------------------------
app.get("/video360", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  const cached = videoCache.get("video360_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT 360:", videoId);
    return res.json(cached.data);
  }

  try {
    // 軽量オプション追加（同じく）
    const cmd = `${YTDLP} --no-playlist --no-check-certificate --no-cache-dir --socket-timeout 10 --sleep-requests 0.5 --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0" --get-url -f "best[ext=mp4][height<=360]/best[ext=mp4]/best" https://youtu.be/${videoId}`;

    const output = execSync(cmd).toString().trim();

    if (!output) throw new Error("No valid 360p stream");

    const data = {
      video: output,
      audio: output,
      source: "yt-dlp-360p-progressive"
    };

    videoCache.set("video360_" + videoId, { data, time: Date.now() });
    console.log("CACHE SAVE 360:", videoId);
    res.json(data);

  } catch (e) {
    console.error("yt-dlp 360p error:", e.message);
    res.status(500).json({
      error: "failed_to_extract_video_360",
      message: e.message
    });
  }
});

// ----------------------------------------------
// サーバー起動
// ----------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ yt-dlp API running on port ${PORT}`);
});
