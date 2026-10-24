import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import {
  CUE_FPS,
  DURATION,
  type Fixture,
  SAMPLE_RATE,
  type Server,
  SHEET,
  STARTUP_INDEXES,
  exitsWithin,
  indexesOf,
  makeFixture,
  startServer,
  waitDecoded,
} from "./helpers";

let fixture: Fixture;
let server: Server | null = null;

async function open(sheet = SHEET) {
  fixture = await makeFixture(sheet);
  server = await startServer(fixture.cue);
  return waitDecoded(server.url);
}

async function restart() {
  await server!.stop();
  server = await startServer(fixture.cue);
  return waitDecoded(server.url);
}

const save = (indexes: unknown, init: RequestInit = {}) =>
  fetch(`${server!.url}api/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ indexes }),
    ...init,
  });

afterEach(async () => {
  await server?.stop();
  server = null;
  fixture?.cleanup();
});

describe("/api/info", () => {
  test("describes the sheet and the decoded audio", async () => {
    const info = await open();
    expect(info.cueName).toBe("mix.cue");
    expect(info.audioName).toBe("mix.aac");
    expect(info.title).toBe("Test Mix");
    expect(info.performer).toBe("Test DJ");
    expect(info.sampleRate).toBe(SAMPLE_RATE);
    // Raw ADTS has no duration of its own; ffprobe estimates one.
    expect(Math.abs(info.duration - DURATION)).toBeLessThan(1);
    expect(info.peaks).toBe("cue-frame-u16");
    expect(info.error).toBe("");
    // AAC adds priming samples, so allow a few frames either way.
    expect(Math.abs(info.frames - DURATION * SAMPLE_RATE)).toBeLessThan(4096);
    expect(info.tracks.map((t: any) => t.index)).toEqual(STARTUP_INDEXES);
    expect(info.tracks[1].title).toBe("Sécond – ツー");
  });

  test("has one peak per cue frame", async () => {
    const info = await open();
    const peaks = new Uint16Array(await (await fetch(`${server!.url}api/peaks`)).arrayBuffer());
    expect(peaks.length).toBe(Math.ceil((info.frames * CUE_FPS) / SAMPLE_RATE));
    expect(Math.max(...peaks)).toBeGreaterThan(1000);
  });
});

describe("baseline for the Δ column", () => {
  test("is the sheet as opened while there is no .bak", async () => {
    const info = await open();
    expect(info.baseline).toEqual(STARTUP_INDEXES);
    expect(info.baselineSource).toBe("");
    expect(existsSync(fixture.bak)).toBe(false);
  });

  test("stays at the original across saves and restarts", async () => {
    await open();
    expect((await save([0, 1600, 3100])).status).toBe(200);
    let info = await waitDecoded(server!.url);
    expect(info.tracks.map((t: any) => t.index)).toEqual([0, 1600, 3100]);
    expect(info.baseline).toEqual(STARTUP_INDEXES);
    expect(info.baselineSource).toBe("mix.cue.bak");

    await save([0, 1610, 3090]);
    info = await restart();
    expect(info.tracks.map((t: any) => t.index)).toEqual([0, 1610, 3090]);
    expect(info.baseline).toEqual(STARTUP_INDEXES);
  });

  test("ignores a .bak with a different number of tracks", async () => {
    fixture = await makeFixture();
    writeFileSync(fixture.bak, 'FILE "mix.aac" WAVE\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n');
    server = await startServer(fixture.cue);
    const info = await waitDecoded(server.url);
    expect(info.baseline).toEqual(STARTUP_INDEXES);
    expect(info.baselineSource).toBe("");
  });
});

describe("/api/save", () => {
  test("rewrites only INDEX 01 lines and keeps the original as .bak", async () => {
    await open();
    const res = await save([0, 1501, 3002]);
    expect(await res.json()).toEqual({ path: fixture.cue, backup: fixture.bak });
    expect(await indexesOf(fixture.cue)).toEqual([0, 1501, 3002]);

    const after = Buffer.from(await Bun.file(fixture.cue).arrayBuffer());
    const expected = Buffer.from(
      SHEET.replace("INDEX 01 00:20:00", "INDEX 01 00:20:01").replace("INDEX 01 00:40:00", "INDEX 01 00:40:02"),
    );
    expect(after.equals(expected)).toBe(true);
    expect(Buffer.from(await Bun.file(fixture.bak).arrayBuffer()).equals(Buffer.from(SHEET))).toBe(true);
  });

  test("does not overwrite an existing .bak", async () => {
    await open();
    await save([0, 1600, 3100]);
    await save([0, 1700, 3200]);
    expect(await indexesOf(fixture.bak)).toEqual(STARTUP_INDEXES);
  });

  test("keeps edits made elsewhere to other lines", async () => {
    await open();
    writeFileSync(fixture.cue, SHEET.replace('TITLE "Third"', 'TITLE "Third (renamed)"'));
    await save([0, 1600, 3100]);
    const text = await Bun.file(fixture.cue).text();
    expect(text).toContain('TITLE "Third (renamed)"');
    expect(await indexesOf(fixture.cue)).toEqual([0, 1600, 3100]);
  });

  test("rejects malformed requests", async () => {
    await open();
    expect((await save([0, 1.5, 3000])).status).toBe(400);
    expect((await save([0, -1, 3000])).status).toBe(400);
    expect((await save("nope")).status).toBe(400);
    const wrongCount = await save([0, 1500]);
    expect(wrongCount.status).toBe(500);
    expect((await wrongCount.json()).error).toContain("3 tracks but 2 indexes");
    expect((await fetch(`${server!.url}api/save`)).status).toBe(405);
    expect(await indexesOf(fixture.cue)).toEqual(STARTUP_INDEXES);
    expect(existsSync(fixture.bak)).toBe(false);
  });
});

describe("/api/pcm", () => {
  test("serves interleaved stereo s16le windows", async () => {
    const info = await open();
    const pcm = async (start: number, count: number) =>
      new Int16Array(await (await fetch(`${server!.url}api/pcm?start=${start}&count=${count}`)).arrayBuffer());
    expect((await pcm(SAMPLE_RATE, 1000)).length).toBe(2000);
    // Clipped at the end of the audio.
    expect((await pcm(info.frames - 10, 1000)).length).toBe(20);
    expect((await pcm(info.frames + 10, 1000)).length).toBe(0);
  });
});

describe("opening another sheet", () => {
  const openPath = (path: string, init: RequestInit = {}) =>
    fetch(`${server!.url}api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
      ...init,
    });

  test("starts without a sheet and opens one later", async () => {
    fixture = await makeFixture();
    server = await startServer(null);
    const empty = await waitDecoded(server.url);
    expect(empty.cuePath).toBe("");
    expect(empty.peaks).toBe("cue-frame-u16");
    expect((await fetch(`${server.url}api/pcm?start=0&count=100`)).headers.get("content-length")).toBe("0");
    expect((await save(STARTUP_INDEXES)).status).toBe(409);

    const res = await openPath(fixture.cue);
    expect(await res.json()).toEqual({ cuePath: fixture.cue });
    const info = await waitDecoded(server.url);
    expect(info.cueName).toBe("mix.cue");
    expect(info.tracks.map((t: any) => t.index)).toEqual(STARTUP_INDEXES);
  });

  test("replaces the open sheet, its audio and its baseline", async () => {
    await open();
    await save([0, 1600, 3100]);
    const other = await makeFixture(SHEET.replace("INDEX 01 00:40:00", "INDEX 01 00:45:00"));
    try {
      expect((await openPath(other.cue)).status).toBe(200);
      const info = await waitDecoded(server!.url);
      expect(info.cuePath).toBe(other.cue);
      expect(info.tracks.map((t: any) => t.index)).toEqual([0, 1500, 3375]);
      expect(info.baseline).toEqual([0, 1500, 3375]);
      expect(info.baselineSource).toBe("");
      const pcm = await fetch(`${server!.url}api/pcm?start=${SAMPLE_RATE}&count=1000`);
      expect((await pcm.arrayBuffer()).byteLength).toBe(4000);

      // A page still showing the first sheet cannot save into the second.
      const stale = await save([0, 1500, 3000], { body: JSON.stringify({ indexes: [0, 1500, 3000], cuePath: fixture.cue }) });
      expect(stale.status).toBe(409);
      expect(await indexesOf(other.cue)).toEqual([0, 1500, 3375]);
      expect(existsSync(other.bak)).toBe(false);
      // The first sheet keeps what was saved to it.
      expect(await indexesOf(fixture.cue)).toEqual([0, 1600, 3100]);
    } finally {
      other.cleanup();
    }
  });

  test("keeps the open sheet when the new one cannot be opened", async () => {
    await open();
    const missing = await openPath(`${fixture.dir}/nope.cue`);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("cue sheet not found");

    writeFileSync(`${fixture.dir}/orphan.cue`, SHEET.replace("mix.aac", "gone.aac"));
    const orphan = await openPath(`${fixture.dir}/orphan.cue`);
    expect(orphan.status).toBe(400);
    expect((await orphan.json()).error).toContain("audio file not found");

    // Not audio at all: refused before anything is replaced, rather than
    // opened with a sample rate of NaN.
    writeFileSync(`${fixture.dir}/text.aac`, "not audio");
    writeFileSync(`${fixture.dir}/text.cue`, SHEET.replace("mix.aac", "text.aac"));
    const text = await openPath(`${fixture.dir}/text.cue`);
    expect(text.status).toBe(400);
    expect((await text.json()).error).toContain("ffprobe failed");

    const info = await waitDecoded(server!.url);
    expect(info.cuePath).toBe(fixture.cue);
  });

  test("refuses requests from other sites", async () => {
    await open();
    const evil = { headers: { "content-type": "application/json", origin: "https://example.com" } };
    expect((await openPath(fixture.cue, evil)).status).toBe(403);
    expect((await save([0, 1600, 3100], evil)).status).toBe(403);
    expect(await indexesOf(fixture.cue)).toEqual(STARTUP_INDEXES);
    // The page itself sends its own origin.
    const own = { headers: { "content-type": "application/json", origin: server!.url.replace(/\/$/, "") } };
    expect((await save([0, 1600, 3100], own)).status).toBe(200);
  });
});

describe("recent sheets", () => {
  const recent = async () => (await fetch(`${server!.url}api/recent`)).json();
  const openPath = (path: string) =>
    fetch(`${server!.url}api/open`, { method: "POST", body: JSON.stringify({ path }) });

  test("are kept across runs, newest first, without the open one", async () => {
    await open();
    const stateDir = server!.stateDir;
    const other = await makeFixture();
    try {
      expect(await recent()).toEqual([]);
      await openPath(other.cue);
      expect(await recent()).toEqual([{ path: fixture.cue, name: "mix.cue", folder: fixture.dir }]);
      await server!.stop({ keepState: true });

      // A later run starts empty and offers both, the last one opened first.
      server = await startServer(null, { CUE_EDIT_STATE_DIR: stateDir });
      expect((await recent()).map((r: any) => r.path)).toEqual([other.cue, fixture.cue]);
      // Reopening one moves it to the top instead of listing it twice.
      await openPath(fixture.cue);
      await openPath(other.cue);
      const list = JSON.parse(readFileSync(`${stateDir}/recent.json`, "utf8"));
      expect(list).toEqual([other.cue, fixture.cue]);

      // A sheet that has gone missing is not offered, but stays on file.
      other.cleanup();
      expect(await recent()).toEqual([{ path: fixture.cue, name: "mix.cue", folder: fixture.dir }]);
      expect(JSON.parse(readFileSync(`${stateDir}/recent.json`, "utf8"))).toEqual([other.cue, fixture.cue]);
    } finally {
      other.cleanup();
    }
  });

  test("keep only the last ten", async () => {
    await open();
    const sheets = Array.from({ length: 11 }, (_, i) => `${fixture.dir}/copy-${i}.cue`);
    for (const sheet of sheets) {
      writeFileSync(sheet, SHEET);
      expect((await openPath(sheet)).status).toBe(200);
    }
    const list = JSON.parse(readFileSync(`${server!.stateDir}/recent.json`, "utf8"));
    expect(list).toEqual(sheets.toReversed().slice(0, 10));
  });
});

describe("while decoding", () => {
  // 60 s of audio at ten times real time: six seconds of decoding to watch.
  const SLOW = { CUE_EDIT_READRATE: "10" };
  const info = async () => (await fetch(`${server!.url}api/info`)).json();

  test("serves the peaks and the PCM decoded so far", async () => {
    fixture = await makeFixture();
    server = await startServer(fixture.cue, SLOW);
    await Bun.sleep(1500);
    const now = await info();
    expect(now.done).toBe(false);
    expect(now.length).toBe(0);
    expect(Math.abs(now.duration - DURATION)).toBeLessThan(1);
    expect(now.frames).toBeGreaterThan(0);
    expect(now.frames).toBeLessThan(DURATION * SAMPLE_RATE * 0.8);
    expect(now.peakCount).toBeGreaterThan(0);

    const from = Math.floor(now.peakCount / 2);
    const rest = new Uint16Array(await (await fetch(`${server!.url}api/peaks?from=${from}`)).arrayBuffer());
    expect(rest.length).toBeGreaterThanOrEqual(now.peakCount - from);
    // PCM is served up to what has been decoded, and no further.
    const pcm = await fetch(`${server!.url}api/pcm?start=0&count=${DURATION * SAMPLE_RATE}`);
    const got = (await pcm.arrayBuffer()).byteLength / 4;
    expect(got).toBeGreaterThanOrEqual(now.frames);
    expect(got).toBeLessThan(DURATION * SAMPLE_RATE);

    const done = await waitDecoded(server!.url);
    expect(done.length).toBe(done.frames);
    expect(done.peakCount).toBe(Math.ceil((done.frames * CUE_FPS) / SAMPLE_RATE));
  }, 20000);

  test("keeps the peaks for the next run, until the audio changes", async () => {
    const first = await open();
    const all = new Uint16Array(await (await fetch(`${server!.url}api/peaks`)).arrayBuffer());
    await server!.stop({ keepState: true });

    // Decoding again (slowly), but the whole waveform is there at once.
    server = await startServer(fixture.cue, { ...SLOW, CUE_EDIT_STATE_DIR: server!.stateDir });
    const again = await info();
    expect(again.done).toBe(false);
    expect(again.length).toBe(first.frames);
    expect(again.peakCount).toBe(all.length);
    const cached = new Uint16Array(await (await fetch(`${server!.url}api/peaks`)).arrayBuffer());
    expect(cached).toEqual(all);
    await server!.stop({ keepState: true });

    // A changed file is not mistaken for the one cached.
    utimesSync(`${fixture.dir}/mix.aac`, new Date(), new Date(Date.now() + 5000));
    server = await startServer(fixture.cue, { ...SLOW, CUE_EDIT_STATE_DIR: server!.stateDir });
    const changed = await info();
    expect(changed.length).toBe(0);
    expect(changed.peakCount).toBeLessThan(all.length);
  }, 20000);
});

describe("going back and forth", () => {
  const openPath = (path: string) =>
    fetch(`${server!.url}api/open`, { method: "POST", body: JSON.stringify({ path }) });
  const info = async () => (await fetch(`${server!.url}api/info`)).json();

  test("reuses the decoded audio of the sheet open before", async () => {
    await open();
    const other = await makeFixture();
    try {
      await openPath(other.cue);
      await waitDecoded(server!.url);
      // Back to the first: no decoding at all.
      await openPath(fixture.cue);
      const back = await info();
      expect(back.cuePath).toBe(fixture.cue);
      expect(back.done).toBe(true);
      const pcm = await fetch(`${server!.url}api/pcm?start=${SAMPLE_RATE}&count=1000`);
      expect((await pcm.arrayBuffer()).byteLength).toBe(4000);
      // And forth again.
      await openPath(other.cue);
      expect((await info()).done).toBe(true);
    } finally {
      other.cleanup();
    }
  });

  test("shares the audio between sheets that name the same file", async () => {
    await open();
    const copy = `${fixture.dir}/copy.cue`;
    writeFileSync(copy, SHEET.replace("INDEX 01 00:40:00", "INDEX 01 00:41:00"));
    await openPath(copy);
    const now = await info();
    expect(now.done).toBe(true);
    expect(now.tracks.map((t: any) => t.index)).toEqual([0, 1500, 3075]);
  });
});

describe("static files", () => {
  test("serves the page and refuses to leave public/", async () => {
    await open();
    const page = await fetch(server!.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>cue-edit</title>");
    expect((await fetch(`${server!.url}app.js`)).status).toBe(200);
    expect((await fetch(`${server!.url}..%2Fcue-edit.ts`)).status).toBe(404);
    expect((await fetch(`${server!.url}nope.txt`)).status).toBe(404);
  });

  test("serves the favicon the page links to", async () => {
    await open();
    expect(await (await fetch(server!.url)).text()).toContain('<link rel="icon" href="/favicon.svg"');
    const icon = await fetch(`${server!.url}favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toStartWith("image/svg+xml");
    expect(await icon.text()).toStartWith("<svg");
  });
});

describe("lifetime", () => {
  const SHORT = { CUE_EDIT_PING_LIMIT_MS: "1200", CUE_EDIT_HIDDEN_LIMIT_MS: "60000" };
  const ping = (hidden: 0 | 1) => fetch(`${server!.url}api/ping?hidden=${hidden}`, { method: "POST" });

  test("exits when a visible page stops pinging", async () => {
    fixture = await makeFixture();
    server = await startServer(fixture.cue, SHORT);
    expect(await exitsWithin(server.proc, 3000)).toBe(true);
  });

  test("waits for a hidden page, and stops waiting once it is back", async () => {
    fixture = await makeFixture();
    server = await startServer(fixture.cue, SHORT);
    expect((await ping(1)).status).toBe(204);
    expect(await exitsWithin(server.proc, 3000)).toBe(false);
    await ping(0);
    expect(await exitsWithin(server.proc, 3000)).toBe(true);
  }, 15000);

  test("exits soon after the page says goodbye", async () => {
    await open();
    await fetch(`${server!.url}api/bye`, { method: "POST" });
    expect(await exitsWithin(server!.proc, 5000)).toBe(true);
  });
});
