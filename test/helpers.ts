// Fixtures for the server and browser tests: a short generated mix, a cue
// sheet for it, and a cue-edit server running against them.

import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

export const CUE_FPS = 75;
export const SAMPLE_RATE = 44100;
export const DURATION = 60; // seconds of audio in the fixture

const ROOT = resolve(import.meta.dir, "..");

// Three tracks at 0:00, 0:20 and 0:40, written with CRLF as most sheets are.
// The second title is UTF-8 so that byte preservation is exercised.
export const SHEET = [
  'PERFORMER "Test DJ"',
  'TITLE "Test Mix"',
  'FILE "mix.aac" WAVE',
  "  TRACK 01 AUDIO",
  '    TITLE "First"',
  '    PERFORMER "Artist A"',
  "    INDEX 01 00:00:00",
  "  TRACK 02 AUDIO",
  '    TITLE "Sécond – ツー"',
  '    PERFORMER "Artist B"',
  "    INDEX 01 00:20:00",
  "  TRACK 03 AUDIO",
  '    TITLE "Third"',
  '    PERFORMER "Artist C"',
  "    INDEX 01 00:40:00",
  "",
].join("\r\n");

export const STARTUP_INDEXES = [0, 20 * CUE_FPS, 40 * CUE_FPS];

// A tone that changes pitch at each split point, so the waveform is not flat.
// Encoded once and kept in the temporary directory: one file, reused by every
// run, rather than one per test. Bump the name when the recipe changes.
const AUDIO = join(tmpdir(), "cue-edit-test-audio-v1.aac");

async function fixtureAudio(): Promise<string> {
  if (existsSync(AUDIO)) return AUDIO;
  const part = `${AUDIO}.${process.pid}.part`;
  await encodeAudio(part);
  renameSync(part, AUDIO);
  return AUDIO;
}

async function encodeAudio(path: string) {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-nostdin", "-v", "error",
      "-f", "lavfi", "-i", `sine=frequency=220:duration=20:sample_rate=${SAMPLE_RATE}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=20:sample_rate=${SAMPLE_RATE}`,
      "-f", "lavfi", "-i", `sine=frequency=880:duration=20:sample_rate=${SAMPLE_RATE}`,
      "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ac", "2",
      "-c:a", "aac", "-f", "adts", path,
    ],
    { stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error("ffmpeg could not create the fixture audio");
}

export type Fixture = { dir: string; cue: string; bak: string; cleanup: () => void };

export async function makeFixture(sheet = SHEET): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cue-edit-test-"));
  copyFileSync(await fixtureAudio(), join(dir, "mix.aac"));
  const cue = join(dir, "mix.cue");
  writeFileSync(cue, sheet);
  return { dir, cue, bak: `${cue}.bak`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Server = {
  url: string;
  proc: Subprocess;
  stateDir: string;
  // keepState leaves the state directory for a later server to share.
  stop: (opts?: { keepState?: boolean }) => Promise<void>;
};

// Resolves to true if the process exits within `ms`.
export async function exitsWithin(proc: Subprocess, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

// Starts cue-edit on a free port and waits for it to report its URL; with
// `cue` null it starts without a sheet. `env` can shorten the keep-alive
// limits (CUE_EDIT_PING_LIMIT_MS and friends), or pass on the CUE_EDIT_STATE_DIR
// of an earlier server; by default each server gets its own, so that the
// tests never touch the list of recent sheets of whoever runs them.
export async function startServer(cue: string | null, env: Record<string, string> = {}): Promise<Server> {
  const stateDir = env.CUE_EDIT_STATE_DIR ?? mkdtempSync(join(tmpdir(), "cue-edit-state-"));
  const proc = Bun.spawn(["bun", join(ROOT, "cue-edit.ts"), ...(cue ? [cue] : []), "--no-open"], {
    stderr: "pipe",
    stdout: "ignore",
    env: { ...process.env, ...env, CUE_EDIT_STATE_DIR: stateDir },
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let log = "";
  let url = "";
  while (!url) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`cue-edit exited before listening:\n${log}`);
    log += decoder.decode(value);
    url = log.match(/cue-edit: (http:\/\/\S+)/)?.[1] ?? "";
  }
  // The page is opened at cue-edit.localhost, which macOS resolves to this
  // machine; not every resolver does (CI runs on Linux), so connect directly.
  url = url.replace("//cue-edit.localhost:", "//127.0.0.1:");
  reader.releaseLock();
  return {
    url,
    proc,
    stateDir,
    stop: async ({ keepState = false } = {}) => {
      proc.kill();
      await proc.exited;
      if (!keepState) rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

// Polls /api/info until decoding has finished.
export async function waitDecoded(url: string): Promise<any> {
  for (;;) {
    const info = await (await fetch(`${url}api/info`)).json();
    if (info.done) return info;
    await Bun.sleep(50);
  }
}

// INDEX 01 values of a sheet on disk, in cue frames.
export async function indexesOf(path: string): Promise<number[]> {
  const text = await Bun.file(path).text();
  return [...text.matchAll(/INDEX 01 (\d+):(\d\d):(\d\d)/g)].map(
    (m) => (Number(m[1]) * 60 + Number(m[2])) * CUE_FPS + Number(m[3]),
  );
}
