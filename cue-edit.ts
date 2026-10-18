#!/usr/bin/env bun
// cue-edit: refine the INDEX points of a cue sheet in the browser.
//
// Usage: cue-edit <sheet.cue> [--port <n>] [--no-open]
//
// The audio referenced by the FILE line is decoded once with ffmpeg into a raw
// PCM file in a temporary directory. The browser fetches waveform peaks (one
// per cue frame) and PCM windows for playback from it, so what it shows and
// plays uses the same decoder (and timeline) as an ffmpeg-based splitter.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CUE_FPS, onlyIndexesChanged, parseCue, rewriteIndexes } from "./lib/cue";

const CHANNELS = 2; // PCM is always served as interleaved stereo s16le
const BYTES_PER_FRAME = CHANNELS * 2;

function usage(code: number): never {
  console.error("Usage: cue-edit <sheet.cue> [--port <n>] [--no-open]");
  process.exit(code);
}

const argv = process.argv.slice(2);
let cuePath = "";
let port = 0;
let openBrowser = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--no-open") openBrowser = false;
  else if (a === "-h" || a === "--help") usage(0);
  else if (!cuePath) cuePath = resolve(a);
  else usage(2);
}
if (!cuePath) usage(2);

const readCueText = async () => Buffer.from(await Bun.file(cuePath).arrayBuffer()).toString("latin1");

let cueText = await readCueText();
const sheet = parseCue(cueText);
const audioPath = resolve(dirname(cuePath), sheet.file);
if (!existsSync(audioPath)) {
  console.error(`audio file not found: ${audioPath}`);
  process.exit(1);
}

async function probeSampleRate(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "inherit" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) throw new Error(`ffprobe failed for ${path}`);
  return Number(out);
}

const sampleRate = await probeSampleRate(audioPath);
const workDir = mkdtempSync(join(tmpdir(), "cue-edit-"));
const pcmPath = join(workDir, "audio.pcm");

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(workDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(0));
}

// Decoding state, filled in while ffmpeg runs.
const decode = {
  done: false,
  error: "",
  frames: 0,
  peaks: [] as Int8Array[],
};

async function runDecode() {
  const proc = Bun.spawn(
    ["ffmpeg", "-nostdin", "-v", "error", "-i", audioPath, "-map", "0:a:0", "-ac", String(CHANNELS), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const writer = Bun.file(pcmPath).writer();
  let carry = new Uint8Array(0);
  // One peak entry per cue frame (1/75 s), the finest step a cue sheet can
  // express. Entry k covers frames [round(k * sr / 75), round((k + 1) * sr / 75)).
  let block = 0;
  let blockEnd = Math.round(sampleRate / CUE_FPS);
  let blockMin = 0;
  let blockMax = 0;
  let blockFill = 0;
  let frame = 0;
  let pending: number[] = [];
  for await (const chunk of proc.stdout) {
    writer.write(chunk);
    let data = chunk as Uint8Array;
    if (carry.length) {
      const merged = new Uint8Array(carry.length + data.length);
      merged.set(carry);
      merged.set(data, carry.length);
      data = merged;
    }
    const whole = data.length - (data.length % BYTES_PER_FRAME);
    const view = new DataView(data.buffer, data.byteOffset, whole);
    for (let off = 0; off < whole; off += BYTES_PER_FRAME) {
      const l = view.getInt16(off, true);
      const r = view.getInt16(off + 2, true);
      const lo = l < r ? l : r;
      const hi = l < r ? r : l;
      if (blockFill === 0 || lo < blockMin) blockMin = lo;
      if (blockFill === 0 || hi > blockMax) blockMax = hi;
      blockFill++;
      if (++frame === blockEnd) {
        pending.push(blockMin >> 8, blockMax >> 8);
        blockFill = 0;
        blockEnd = Math.round(((++block + 1) * sampleRate) / CUE_FPS);
      }
    }
    decode.frames += whole / BYTES_PER_FRAME;
    carry = data.slice(whole);
    if (pending.length >= 8192) {
      decode.peaks.push(Int8Array.from(pending));
      pending = [];
    }
  }
  if (blockFill > 0) pending.push(blockMin >> 8, blockMax >> 8);
  if (pending.length) decode.peaks.push(Int8Array.from(pending));
  await writer.end();
  const code = await proc.exited;
  if (code !== 0) {
    decode.error = (await new Response(proc.stderr).text()).trim() || `ffmpeg exited with ${code}`;
    console.error(decode.error);
  }
  decode.done = true;
}

const decodeStarted = performance.now();
runDecode().then(() => {
  if (!decode.error) {
    const secs = ((performance.now() - decodeStarted) / 1000).toFixed(1);
    console.error(`decoded ${(decode.frames / sampleRate).toFixed(1)} s of audio in ${secs} s`);
  }
});

function peaksBody(): Uint8Array {
  const total = decode.peaks.reduce((n, p) => n + p.length, 0);
  const out = new Int8Array(total);
  let off = 0;
  for (const p of decode.peaks) {
    out.set(p, off);
    off += p.length;
  }
  return new Uint8Array(out.buffer);
}

let backupPath = "";

async function save(indexes: number[]) {
  // Re-read so that edits made elsewhere to non-INDEX lines are not lost.
  const current = await readCueText();
  const next = rewriteIndexes(current, indexes);
  if (!onlyIndexesChanged(current, next)) throw new Error("refusing to save: lines other than INDEX 01 would change");
  if (!backupPath) {
    const candidate = `${cuePath}.bak`;
    if (!existsSync(candidate)) copyFileSync(cuePath, candidate);
    backupPath = candidate;
  }
  await Bun.write(cuePath, Buffer.from(next, "latin1"));
  cueText = next;
  return { path: cuePath, backup: backupPath };
}

// The page reports when it is closed; exit unless it comes back (reload).
let byeTimer: Timer | null = null;
function scheduleExit() {
  if (byeTimer) clearTimeout(byeTimer);
  byeTimer = setTimeout(() => {
    console.error("page closed; exiting");
    process.exit(0);
  }, 3000);
}

const publicDir = join(import.meta.dir, "public");
const json = (data: unknown, status = 200) => Response.json(data, { status });

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (byeTimer && url.pathname.startsWith("/api/")) {
      clearTimeout(byeTimer);
      byeTimer = null;
    }
    switch (url.pathname) {
      case "/":
        return new Response(Bun.file(join(publicDir, "index.html")));
      case "/api/info": {
        // Re-read so that a reload picks up edits made to the sheet elsewhere.
        cueText = await readCueText();
        const s = parseCue(cueText);
        return json({
          cuePath,
          cueName: basename(cuePath),
          audioName: basename(audioPath),
          title: s.title,
          performer: s.performer,
          sampleRate,
          frames: decode.frames,
          done: decode.done,
          error: decode.error,
          tracks: s.tracks,
        });
      }
      case "/api/peaks":
        return new Response(peaksBody(), { headers: { "content-type": "application/octet-stream" } });
      case "/api/pcm": {
        const start = Math.max(0, Math.floor(Number(url.searchParams.get("start"))));
        const count = Math.max(0, Math.floor(Number(url.searchParams.get("count"))));
        const end = Math.min(decode.frames, start + count);
        if (!decode.done || end <= start) return new Response(new Uint8Array(0));
        return new Response(Bun.file(pcmPath).slice(start * BYTES_PER_FRAME, end * BYTES_PER_FRAME), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      case "/api/save": {
        if (req.method !== "POST") return json({ error: "POST only" }, 405);
        try {
          const { indexes } = (await req.json()) as { indexes: number[] };
          if (!Array.isArray(indexes) || !indexes.every((n) => Number.isInteger(n) && n >= 0)) {
            return json({ error: "indexes must be non-negative integers" }, 400);
          }
          return json(await save(indexes));
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      }
      case "/api/bye":
        scheduleExit();
        return new Response(null, { status: 204 });
    }
    const file = Bun.file(join(publicDir, url.pathname.replace(/^\/+/, "")));
    if (!url.pathname.includes("..") && (await file.exists())) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

const pageUrl = `http://127.0.0.1:${server.port}/`;
console.error(`cue-edit: ${pageUrl}`);
if (openBrowser) Bun.spawn(["open", pageUrl]);
