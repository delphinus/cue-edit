import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
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
