#!/usr/bin/env bun
// cue-edit: refine the INDEX points of a cue sheet in the browser.
//
// Usage: cue-edit [<sheet.cue>] [--port <n>] [--no-open]
//
// The audio referenced by the FILE line is decoded once with ffmpeg into a raw
// PCM file in a temporary directory. The browser fetches waveform peaks (one
// per cue frame) and PCM windows for playback from it, so what it shows and
// plays uses the same decoder (and timeline) as an ffmpeg-based splitter.
//
// Without a sheet the page starts empty; it can open one (and switch to
// another later) through a native file dialog that this server shows.

import type { Subprocess } from "bun";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CUE_FPS, onlyIndexesChanged, parseCue, rewriteIndexes } from "./lib/cue";

const PEAKS_FORMAT = "cue-frame-u16"; // one little-endian u16 peak per cue frame
const CHANNELS = 2; // PCM is always served as interleaved stereo s16le
const BYTES_PER_FRAME = CHANNELS * 2;

function usage(code: number): never {
  console.error("Usage: cue-edit [<sheet.cue>] [--port <n>] [--no-open]");
  process.exit(code);
}

const argv = process.argv.slice(2);
let initialCue = "";
let port = 0;
let openBrowser = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--no-open") openBrowser = false;
  else if (a === "-h" || a === "--help") usage(0);
  else if (!initialCue) initialCue = resolve(a);
  else usage(2);
}

const readLatin1 = async (path: string) => Buffer.from(await Bun.file(path).arrayBuffer()).toString("latin1");

// Sample rate of the first audio stream, and the duration in seconds (0 when
// the container does not say, as with raw ADTS). JSON rather than CSV: CSV
// adds a column for each kind of side data, so an MP3 came out as "44100,".
async function probeAudio(path: string): Promise<{ sampleRate: number; duration: number }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate:format=duration", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${err.trim()}`);
  const probe = JSON.parse(out) as { streams?: { sample_rate?: string }[]; format?: { duration?: string } };
  const sampleRate = Number(probe.streams?.[0]?.sample_rate);
  if (!(sampleRate > 0)) throw new Error(`no audio stream found in ${path}`);
  return { sampleRate, duration: Number(probe.format?.duration) || 0 };
}

const workDir = mkdtempSync(join(tmpdir(), "cue-edit-"));
// Child processes that must not outlive the server.
const children = new Set<Subprocess>();

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const proc of children) proc.kill();
  rmSync(workDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(0));
}

// Sheets opened recently, newest first, kept across runs so that they can be
// reopened from the page and the file dialog starts where the last one was.
// The page cannot keep them: its origin, and so its storage, changes with the
// port on every run. CUE_EDIT_STATE_DIR moves the file (for tests).
const RECENT_MAX = 10;
const stateDir =
  process.env.CUE_EDIT_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cue-edit");
const recentPath = join(stateDir, "recent.json");
const home = homedir();
const tilde = (p: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

function readRecent(): string[] {
  try {
    const list = JSON.parse(readFileSync(recentPath, "utf8"));
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberSheet(path: string) {
  const list = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX);
  try {
    mkdirSync(stateDir, { recursive: true });
    // Written aside and renamed, so that a crash never leaves half a file.
    const tmp = `${recentPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
    renameSync(tmp, recentPath);
  } catch (e) {
    console.error(`cannot record ${path} in ${recentPath}: ${(e as Error).message}`);
  }
}

// Peaks of decoded audio, kept across runs so that a mix opened before shows
// its waveform at once (the PCM for playback is still decoded meanwhile). An
// entry is used only while the audio file has the same path, size and
// modification time.
const PEAKS_CACHE_MAX = 20;
const peaksDir = join(stateDir, "peaks");

type PeaksKey = { path: string; size: number; mtimeMs: number; sampleRate: number };

function peaksCachePath(key: PeaksKey): string {
  const hash = new Bun.CryptoHasher("sha1").update(JSON.stringify([PEAKS_FORMAT, key])).digest("hex");
  return join(peaksDir, `${hash}.peaks`);
}

// The cached peaks and the frame count they were made from, or null.
function readCachedPeaks(key: PeaksKey): { peaks: Uint16Array; frames: number } | null {
  try {
    const buf = readFileSync(peaksCachePath(key));
    // An 8-byte frame count, then the peaks.
    const frames = Number(buf.readBigUInt64LE(0));
    const peaks = new Uint16Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length));
    return { peaks, frames };
  } catch {
    return null;
  }
}

function writeCachedPeaks(key: PeaksKey, peaks: Uint16Array, frames: number) {
  const path = peaksCachePath(key);
  try {
    mkdirSync(peaksDir, { recursive: true });
    const head = Buffer.alloc(8);
    head.writeBigUInt64LE(BigInt(frames));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat([head, Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength)]));
    renameSync(tmp, path);
    // Keep the newest entries only.
    const entries = readdirSync(peaksDir)
      .filter((f) => f.endsWith(".peaks"))
      .map((f) => ({ f, t: statSync(join(peaksDir, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    for (const { f } of entries.slice(PEAKS_CACHE_MAX)) rmSync(join(peaksDir, f), { force: true });
  } catch (e) {
    console.error(`cannot cache the peaks in ${path}: ${(e as Error).message}`);
  }
}

// A decoded audio file: the PCM for playback in a temporary file, and one
// peak per cue frame for the waveform. Both grow while ffmpeg runs, and the
// page uses what there is so far.
type Audio = {
  key: PeaksKey;
  sampleRate: number;
  // Seconds, from the container; 0 when unknown. Only an estimate of the
  // length until decoding is done.
  duration: number;
  pcmPath: string;
  decoder: Subprocess | null;
  done: boolean;
  error: string;
  // Frames of PCM written to pcmPath so far, which /api/pcm can serve.
  frames: number;
  // Frames in the whole file: known once decoded, or from the peaks cache.
  length: number;
  peaks: Uint16Array; // the first peakCount entries are valid
  peakCount: number;
  // The peaks came from the cache, so decoding only produces the PCM.
  peaksCached: boolean;
};

// Everything that belongs to the open sheet. Opening another sheet replaces
// the whole session, so nothing of the previous one can leak into it.
type Session = {
  cuePath: string;
  audio: Audio;
  // INDEX values as opened; see readBaseline.
  startupIndexes: number[];
  backupPath: string;
};

let session: Session | null = null;
// The audio of the sheet open before, kept (once decoded) so that going back
// to it does not decode it again. One is enough for going back and forth.
let keptAudio: Audio | null = null;
let audioCount = 0;

const sameKey = (a: PeaksKey, b: PeaksKey) =>
  a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.sampleRate === b.sampleRate;

// Opens `path` and makes it the current sheet. Throws, leaving the current
// sheet open, if the sheet cannot be read or its audio is missing.
async function openSheet(path: string): Promise<Session> {
  const cuePath = resolve(path);
  if (!existsSync(cuePath)) throw new Error(`cue sheet not found: ${cuePath}`);
  const sheet = parseCue(await readLatin1(cuePath));
  const audioPath = resolve(dirname(cuePath), sheet.file);
  if (!existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);
  const probe = await probeAudio(audioPath);
  const stat = statSync(audioPath);
  const key: PeaksKey = { path: audioPath, size: stat.size, mtimeMs: stat.mtimeMs, sampleRate: probe.sampleRate };

  const prev = session?.audio ?? null;
  let audio: Audio;
  let reused = "";
  if (prev && sameKey(prev.key, key)) {
    audio = prev; // another sheet for the same audio
    reused = "the audio already open";
  } else if (keptAudio && sameKey(keptAudio.key, key)) {
    audio = keptAudio;
    keptAudio = null;
    reused = "the audio kept from before";
  } else {
    audio = newAudio(key, probe);
  }
  session = {
    cuePath,
    audio,
    startupIndexes: sheet.tracks.map((t) => t.index),
    backupPath: "",
  };
  if (prev && prev !== audio) retire(prev);
  console.error(`opened ${cuePath}${reused ? ` (reusing ${reused})` : ""}`);
  rememberSheet(cuePath);
  if (!reused) startDecode(audio);
  return session;
}

function newAudio(key: PeaksKey, probe: { sampleRate: number; duration: number }): Audio {
  const cached = readCachedPeaks(key);
  // Room for the estimated length, so that the array rarely has to grow.
  const estimate = Math.ceil(probe.duration * CUE_FPS) + 1;
  return {
    key,
    ...probe,
    pcmPath: join(workDir, `audio-${++audioCount}.pcm`),
    decoder: null,
    done: false,
    error: "",
    frames: 0,
    length: cached?.frames ?? 0,
    peaks: cached?.peaks ?? new Uint16Array(Math.max(1024, estimate)),
    peakCount: cached?.peaks.length ?? 0,
    peaksCached: cached !== null,
  };
}

// The audio of the sheet that was open: kept for going back if it was decoded
// in full, dropped otherwise (along with the one kept before).
function retire(a: Audio) {
  if (a.done && !a.error) {
    if (keptAudio) dropAudio(keptAudio);
    keptAudio = a;
  } else {
    dropAudio(a);
  }
}

function dropAudio(a: Audio) {
  a.decoder?.kill();
  rmSync(a.pcmPath, { force: true });
}

function startDecode(a: Audio) {
  const started = performance.now();
  runDecode(a).then(() => {
    if (a.error || !a.done) return;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    console.error(`decoded ${(a.frames / a.sampleRate).toFixed(1)} s of audio in ${secs} s`);
  });
}

function pushPeak(a: Audio, peak: number) {
  if (a.peakCount === a.peaks.length) {
    const grown = new Uint16Array(a.peaks.length * 2);
    grown.set(a.peaks);
    a.peaks = grown;
  }
  a.peaks[a.peakCount++] = peak;
}

async function runDecode(a: Audio) {
  const { sampleRate } = a;
  // CUE_EDIT_READRATE slows decoding down to that multiple of real time, so
  // that tests can watch a page work while the audio is still being decoded.
  const readrate = process.env.CUE_EDIT_READRATE ? ["-readrate", process.env.CUE_EDIT_READRATE] : [];
  const proc = Bun.spawn(
    ["ffmpeg", "-nostdin", "-v", "error", ...readrate, "-i", a.key.path, "-map", "0:a:0", "-ac", String(CHANNELS), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  a.decoder = proc;
  children.add(proc);
  const writer = Bun.file(a.pcmPath).writer();
  let carry = new Uint8Array(0);
  // One peak entry per cue frame (1/75 s), the finest step a cue sheet can
  // express: the largest absolute sample of both channels, kept at 16 bits so
  // that quiet passages can be drawn on a dB scale. Entry k covers frames
  // [round(k * sr / 75), round((k + 1) * sr / 75)).
  let block = 0;
  let blockEnd = Math.round(sampleRate / CUE_FPS);
  let blockPeak = 0;
  let blockFill = 0;
  let frame = 0;
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
    if (!a.peaksCached) {
      const view = new DataView(data.buffer, data.byteOffset, whole);
      for (let off = 0; off < whole; off += BYTES_PER_FRAME) {
        const l = Math.abs(view.getInt16(off, true));
        const r = Math.abs(view.getInt16(off + 2, true));
        if (l > blockPeak) blockPeak = l;
        if (r > blockPeak) blockPeak = r;
        blockFill++;
        if (++frame === blockEnd) {
          pushPeak(a, blockPeak);
          blockPeak = 0;
          blockFill = 0;
          blockEnd = Math.round(((++block + 1) * sampleRate) / CUE_FPS);
        }
      }
    }
    carry = data.slice(whole);
    // Only what has reached the file can be served for playback.
    await writer.flush();
    a.frames += whole / BYTES_PER_FRAME;
  }
  if (!a.peaksCached && blockFill > 0) pushPeak(a, blockPeak);
  await writer.end();
  const code = await proc.exited;
  children.delete(proc);
  // Killed because another sheet was opened: nothing is waiting for it.
  if (a.decoder !== proc || proc.signalCode) return;
  a.decoder = null;
  if (code !== 0) {
    a.error = (await new Response(proc.stderr).text()).trim() || `ffmpeg exited with ${code}`;
    console.error(a.error);
  } else {
    if (a.peaksCached && a.length !== a.frames) {
      console.error(`cached peaks were for ${a.length} frames, decoded ${a.frames}`);
    }
    a.length = a.frames;
    if (!a.peaksCached) writeCachedPeaks(a.key, a.peaks.subarray(0, a.peakCount), a.frames);
  }
  a.done = true;
}

// Peaks from entry `from` on, as little-endian u16.
function peaksBody(a: Audio, from: number): Uint8Array {
  const part = a.peaks.slice(Math.min(from, a.peakCount), a.peakCount);
  return new Uint8Array(part.buffer);
}

// The INDEX values the Δ column is measured from: the `.bak` copy of the sheet
// (the state before the first save) when there is one, otherwise the sheet as
// it was when it was opened, which is what the first save will back up.
// Either way the baseline survives reloads and saves.
async function readBaseline(s: Session, tracks: number): Promise<{ indexes: number[]; source: string }> {
  const bak = `${s.cuePath}.bak`;
  if (existsSync(bak)) {
    try {
      const indexes = parseCue(await readLatin1(bak)).tracks.map((t) => t.index);
      // A .bak left over from another version of the sheet cannot be compared.
      if (indexes.length === tracks) return { indexes, source: basename(bak) };
      console.error(`ignoring ${bak}: ${indexes.length} tracks, the sheet has ${tracks}`);
    } catch (e) {
      console.error(`ignoring ${bak}: ${(e as Error).message}`);
    }
  }
  if (s.startupIndexes.length === tracks) return { indexes: s.startupIndexes, source: "" };
  return { indexes: [], source: "" };
}

async function save(s: Session, indexes: number[]) {
  // Re-read so that edits made elsewhere to non-INDEX lines are not lost.
  const current = await readLatin1(s.cuePath);
  const next = rewriteIndexes(current, indexes);
  if (!onlyIndexesChanged(current, next)) throw new Error("refusing to save: lines other than INDEX 01 would change");
  if (!s.backupPath) {
    const candidate = `${s.cuePath}.bak`;
    if (!existsSync(candidate)) copyFileSync(s.cuePath, candidate);
    s.backupPath = candidate;
  }
  await Bun.write(s.cuePath, Buffer.from(next, "latin1"));
  return { path: s.cuePath, backup: s.backupPath };
}

// Shows the macOS file dialog and resolves to the chosen path, or "" when it
// is cancelled. The page cannot do this itself: a browser hands a page the
// contents of a file, never its path, and the server needs the path to find
// the audio next to the sheet and to save in place.
let choosing = false;
async function chooseSheet(): Promise<string> {
  // The folder of the open sheet, else of the last one opened (in an earlier
  // run, as the page starts empty), else where cue-edit was started.
  const last = session?.cuePath ?? readRecent()[0];
  const from = last && existsSync(dirname(last)) ? dirname(last) : process.cwd();
  const proc = Bun.spawn(
    [
      "osascript",
      "-e", "on run argv",
      // No `activate`: it adds two seconds, and the dialog comes to the front
      // without it (osascript puts it on the modal panel layer).
      "-e", 'POSIX path of (choose file with prompt "Open a cue sheet" of type {"cue"} default location (POSIX file (item 1 of argv)))',
      "-e", "end run",
      from,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  children.add(proc);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  children.delete(proc);
  if (code === 0) return out.trim();
  if (err.includes("-128")) return ""; // User canceled.
  throw new Error(err.trim() || `osascript exited with ${code}`);
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

// The bye beacon is not always delivered (a closed Safari tab left the server
// running), so the page also pings while it is open. A hidden page cannot be
// relied on to ping at all: Safari stops the timers of background tabs, and
// the server used to exit under a page that was merely in the background. The
// page therefore says when it is hidden, and the server then waits much
// longer. Both limits can be shortened for tests.
const limit = (name: string, fallback: number) => Number(process.env[name]) || fallback;
const PING_LIMIT_MS = limit("CUE_EDIT_PING_LIMIT_MS", 5 * 60 * 1000);
const HIDDEN_LIMIT_MS = limit("CUE_EDIT_HIDDEN_LIMIT_MS", 12 * 60 * 60 * 1000);
let lastSeen = Date.now();
let pageHidden = false;
setInterval(
  () => {
    if (Date.now() - lastSeen > (pageHidden ? HIDDEN_LIMIT_MS : PING_LIMIT_MS)) {
      console.error(`no word from the ${pageHidden ? "hidden " : ""}page; exiting`);
      process.exit(0);
    }
  },
  Math.min(10 * 1000, PING_LIMIT_MS / 4),
);

const publicDir = join(import.meta.dir, "public");

// Requests that open or write files must come from this page, not from
// another site the browser happens to have open. Browsers send Origin with
// every POST; tools such as curl send none, and are let through.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}
const json = (data: unknown, status = 200) => Response.json(data, { status });

if (initialCue) {
  try {
    await openSheet(initialCue);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/bye") {
      lastSeen = Date.now();
      if (byeTimer) {
        clearTimeout(byeTimer);
        byeTimer = null;
      }
    }
    switch (url.pathname) {
      case "/api/ping":
        // ?hidden=1 when the page goes to the background, 0 when it is back.
        pageHidden = url.searchParams.get("hidden") === "1";
        return new Response(null, { status: 204 });
      case "/":
        return new Response(Bun.file(join(publicDir, "index.html")));
      case "/api/info": {
        // An empty page: nothing has been opened yet.
        if (!session) return json({ cuePath: "", peaks: PEAKS_FORMAT, peakCount: 0, done: true, error: "" });
        const s = session;
        // Re-read so that a reload picks up edits made to the sheet elsewhere.
        const sheet = parseCue(await readLatin1(s.cuePath));
        const baseline = await readBaseline(s, sheet.tracks.length);
        return json({
          cuePath: s.cuePath,
          cueName: basename(s.cuePath),
          audioName: basename(s.audio.key.path),
          title: sheet.title,
          performer: sheet.performer,
          sampleRate: s.audio.sampleRate,
          duration: s.audio.duration,
          // Format of /api/peaks; the page refuses to run against another.
          peaks: PEAKS_FORMAT,
          // PCM decoded so far, which /api/pcm serves; the whole file once done.
          frames: s.audio.frames,
          // Frames in the whole file, or 0 while that is not known yet.
          length: s.audio.length,
          // Peak entries available from /api/peaks so far.
          peakCount: s.audio.peakCount,
          done: s.audio.done,
          error: s.audio.error,
          tracks: sheet.tracks,
          // INDEX values to measure Δ from; empty when none fits the sheet.
          baseline: baseline.indexes,
          // Name of the .bak they came from; empty when it is the state as opened.
          baselineSource: baseline.source,
        });
      }
      case "/api/recent":
        // Sheets that have gone missing since are left out, but stay in the
        // file in case their disk comes back.
        return json(
          readRecent()
            .filter((p) => p !== session?.cuePath && existsSync(p))
            .map((path) => ({ path, name: basename(path), folder: tilde(dirname(path)) })),
        );
      case "/api/peaks":
        // ?from=n returns the entries from n on, for a page that has the rest.
        if (!session) return new Response(new Uint8Array(0));
        return new Response(peaksBody(session.audio, Math.max(0, Math.floor(Number(url.searchParams.get("from")) || 0))), {
          headers: { "content-type": "application/octet-stream" },
        });
      case "/api/pcm": {
        const a = session?.audio;
        if (!a) return new Response(new Uint8Array(0));
        const start = Math.max(0, Math.floor(Number(url.searchParams.get("start"))));
        const count = Math.max(0, Math.floor(Number(url.searchParams.get("count"))));
        // Clipped to what has been decoded so far.
        const end = Math.min(a.frames, start + count);
        if (end <= start) return new Response(new Uint8Array(0));
        return new Response(Bun.file(a.pcmPath).slice(start * BYTES_PER_FRAME, end * BYTES_PER_FRAME), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      case "/api/save": {
        if (req.method !== "POST") return json({ error: "POST only" }, 405);
        if (!sameOrigin(req)) return json({ error: "cross-origin request" }, 403);
        try {
          const { indexes, cuePath } = (await req.json()) as { indexes: number[]; cuePath?: string };
          if (!Array.isArray(indexes) || !indexes.every((n) => Number.isInteger(n) && n >= 0)) {
            return json({ error: "indexes must be non-negative integers" }, 400);
          }
          // A page left open on the previous sheet must not write into this one.
          if (!session || (cuePath !== undefined && cuePath !== session.cuePath)) {
            return json({ error: "another cue sheet has been opened since; reload the page" }, 409);
          }
          return json(await save(session, indexes));
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      }
      case "/api/open": {
        // Opens { path } if given, otherwise asks for one with the file dialog.
        if (req.method !== "POST") return json({ error: "POST only" }, 405);
        if (!sameOrigin(req)) return json({ error: "cross-origin request" }, 403);
        let path = "";
        try {
          path = String(((await req.json().catch(() => ({}))) as { path?: unknown }).path ?? "");
          if (!path) {
            if (choosing) return json({ error: "the file dialog is already open" }, 409);
            // Bun closes requests idle for 10 s; choosing a file takes longer.
            server.timeout(req, 0);
            choosing = true;
            try {
              path = await chooseSheet();
            } finally {
              choosing = false;
            }
            if (!path) return json({ cancelled: true });
          }
          const s = await openSheet(path);
          return json({ cuePath: s.cuePath });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
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

// A name rather than 127.0.0.1, which is what Safari shows in its address
// field. macOS resolves every *.localhost name to this machine.
const pageUrl = `http://cue-edit.localhost:${server.port}/`;
console.error(`cue-edit: ${pageUrl}`);
if (openBrowser) Bun.spawn(["open", pageUrl]);
