const express = require('express');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { mkdtemp, rm } = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const run = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Жестко задаем ссылку, чтобы исключить любые проблемы с env-переменными на Render
const FRONTEND_URL = 'https://akhmovane-zeta.vercel.app';
console.log("=== FRONTEND_URL IS:", FRONTEND_URL);

function parseVtt(text) {
  const cues = [];
  const blocks = text.trim().split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (block.startsWith("WEBVTT")) continue;
    const lines = block.split(/\r?\n/);
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const [start, end] = timeLine.split('-->').map(t => {
      const parts = t.trim().split(':');
      let s = 0;
      if (parts.length === 3) {
        s = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      } else {
        s = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
      }
      return s;
    });
    cues.push({ start, end });
  }
  return cues;
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const fileStream = fs.createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body), fileStream);
}

app.post('/api/reel', async (req, res) => {
  let { videoUrl, vttUrl, outtakes } = req.body;

  // Жесткая защита от undefined, null или строковых значений "undefined"
  if (!videoUrl || videoUrl === "undefined") videoUrl = "/videos/kaichemodzmao.mp4";
  if (!vttUrl || vttUrl === "undefined") vttUrl = "/subtitles/kaichemodzmao.vtt";

  if (!Array.isArray(outtakes)) {
    return res.status(400).json({ error: "Missing outtakes array" });
  }

  let dir;
  try {
    const list = [...outtakes].sort((a, b) => a.cue - b.cue);
    if (!list.length) return res.status(400).json({ error: "აუთთეიქები ჯერ არ არის." });

    dir = await mkdtemp(path.join(os.tmpdir(), "akhovane-render-"));

    const videoPath = path.join(dir, 'source.mp4');
    const vttPath = path.join(dir, 'subs.vtt');
    
    await Promise.all([
      downloadFile(FRONTEND_URL + videoUrl, videoPath),
      downloadFile(FRONTEND_URL + vttUrl, vttPath)
    ]);

    const vttText = await fs.promises.readFile(vttPath, 'utf8');
    const cues = parseVtt(vttText);
    const segs = [];

    for (const [n, o] of list.entries()) {
      const c = cues[o.cue];
      if (!c) continue;
      
      const dur = c.end - c.start;
      const ext = o.type?.includes("mp4") ? "m4a" : o.type?.includes("ogg") ? "ogg" : "webm";
      const audioPath = path.join(dir, `a${n}.${ext}`);
      const segPath = `s${n}.mp4`;

      await downloadFile(o.url, audioPath);

      await run(ffmpegPath, [
        "-y", "-ss", String(c.start), "-t", String(dur), "-i", videoPath,
        "-ss", String(o.offset), "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0", "-t", String(dur),
        "-vf", "fps=30", "-c:v", "libx264", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", "-af", "apad", "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "160k",
        segPath
      ], { cwd: dir });

      segs.push(segPath);
    }

    if (!segs.length) throw new Error("No segments generated");

    const listPath = path.join(dir, "list.txt");
    await fs.promises.writeFile(listPath, segs.map(s => `file '${s}'`).join("\n"));

    await run(ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "reel.mp4"
    ], { cwd: dir });

    const finalPath = path.join(dir, "reel.mp4");
    
    res.sendFile(finalPath, (err) => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    });

  } catch (error) {
    console.error("FFmpeg Error:", error);
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ error: "აუთთეიქების ვიდეოს შექმნა ვერ მოხერხდა." });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render Microservice started on port ${PORT}`));
