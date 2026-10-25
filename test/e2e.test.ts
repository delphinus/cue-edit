// Drives the page in headless Chromium against a real server. Needs the
// browser once: `bunx playwright install chromium-headless-shell`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Browser, type Page, chromium } from "playwright";
import {
  type Fixture,
  type Server,
  SHEET,
  STARTUP_INDEXES,
  exitsWithin,
  indexesOf,
  makeFixture,
  startServer,
} from "./helpers";

let browser: Browser;
let fixture: Fixture;
let server: Server;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  fixture = await makeFixture();
  server = await startServer(fixture.cue);
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await openPage();
});
afterEach(async () => {
  await page.close();
  await server.stop();
  fixture.cleanup();
});

// The page is ready once the decoding notice is hidden.
async function openPage() {
  await page.goto(server.url);
  await page.waitForSelector("#loading", { state: "hidden" });
}

const rows = () =>
  page.$$eval("#track-rows tr", (trs) =>
    trs.map((tr) => ({
      cells: [...tr.children].map((td) => td.textContent),
      selected: tr.classList.contains("selected"),
      edited: tr.classList.contains("edited"),
    })),
  );
const column = async (n: number) => (await rows()).map((r) => r.cells[n]);
const pos = () => page.textContent("#pos");

// The readout is redrawn on the next animation frame, so wait for it.
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function press(key: string) {
  await page.keyboard.press(key);
  await frames();
}

describe("page", () => {
  test("lists the tracks of the sheet", async () => {
    expect(await page.textContent("#title")).toBe("Test DJ – Test Mix");
    expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);
    expect(await column(2)).toEqual(["", "", ""]);
    expect(await column(3)).toEqual(["Artist A – First", "Artist B – Sécond – ツー", "Artist C – Third"]);
    expect(await page.isDisabled("#save")).toBe(true);
    expect(await page.title()).toBe("mix.cue");
  });

  test("opens the help dialog with ?", async () => {
    await press("?");
    expect(await page.$eval("#help", (d: HTMLDialogElement) => d.open)).toBe(true);
    await press("Escape");
    expect(await page.$eval("#help", (d: HTMLDialogElement) => d.open)).toBe(false);
  });
});

describe("editing", () => {
  test("moves a split point, undoes, saves and keeps Δ across a reload", async () => {
    // ] jumps to the next split point and selects it.
    await press("]");
    expect(await pos()).toBe("0:20.000 (00:20:00)");
    expect((await rows()).map((r) => r.selected)).toEqual([false, true, false]);

    // ⇧→ moves the cursor by one cue frame; M puts the split point there.
    for (let i = 0; i < 5; i++) await press("Shift+ArrowRight");
    expect(await pos()).toBe("0:20.067 (00:20:05)");
    await press("m");
    expect(await column(1)).toEqual(["00:00:00", "00:20:05", "00:40:00"]);
    expect(await column(2)).toEqual(["", "+0.07", ""]);
    expect((await rows()).map((r) => r.edited)).toEqual([false, true, false]);
    expect(await page.title()).toBe("● mix.cue");
    expect(await page.isDisabled("#save")).toBe(false);

    await press("Meta+z");
    expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);
    expect(await page.title()).toBe("mix.cue");
    await press("Meta+Shift+z");
    expect(await column(1)).toEqual(["00:00:00", "00:20:05", "00:40:00"]);

    await press("Meta+s");
    await page.waitForFunction(() => document.title === "mix.cue");
    expect(await page.textContent("#toast")).toBe("Saved mix.cue (1 split point changed)");
    expect(await indexesOf(fixture.cue)).toEqual([0, 1505, 3000]);
    expect(await indexesOf(fixture.bak)).toEqual(STARTUP_INDEXES);

    // Δ is measured from the .bak, so it survives a reload.
    await openPage();
    expect(await column(1)).toEqual(["00:00:00", "00:20:05", "00:40:00"]);
    expect(await column(2)).toEqual(["", "+0.07", ""]);
    expect(await page.$eval("#delta-head", (th) => th.getAttribute("title"))).toContain("mix.cue.bak");
  });

  test("puts the split point nearest to a drag on the selection start", async () => {
    await press("0"); // whole file in view
    const box = (await page.locator("#overlay").boundingBox())!;
    const xAt = (secs: number) => box.x + (box.width * secs) / 60;
    const y = box.y + box.height / 2;
    await page.mouse.move(xAt(16), y);
    await page.mouse.down();
    await page.mouse.move(xAt(17), y, { steps: 5 });
    await page.mouse.up();
    await frames();
    expect((await rows()).map((r) => r.selected)).toEqual([false, true, false]);

    await press("m");
    const [, moved] = await column(1);
    const [mm, ss] = moved!.split(":").map(Number);
    expect(mm * 60 + ss).toBeGreaterThanOrEqual(15);
    expect(mm * 60 + ss).toBeLessThanOrEqual(16);

    // 4 nudges the selection by one cue frame; M follows it.
    await press("4");
    await press("m");
    const [, nudged] = await column(1);
    const cue = (t: string) => t.split(":").map(Number).reduce((acc, n, i) => (i < 2 ? acc * 60 + n : acc * 75 + n), 0);
    expect(cue(nudged!) - cue(moved!)).toBe(1);
  });

  test("keeps split points in order", async () => {
    await press("]");
    await press("ArrowDown"); // cursor to the end of the file
    await press("m");
    // Stops one cue frame before the next split point.
    expect(await column(1)).toEqual(["00:00:00", "00:39:74", "00:40:00"]);
  });

  test("[ goes to the start of the current track unless on a split point", async () => {
    const selected = async () => (await rows()).findIndex((r) => r.selected);
    await press("]");
    await press("ArrowRight");
    await press("[");
    expect(await pos()).toBe("0:20.000 (00:20:00)");
    expect(await selected()).toBe(1);
    // On the split point, it goes on to the previous track.
    await press("[");
    expect(await pos()).toBe("0:00.000 (00:00:00)");
    expect(await selected()).toBe(0);
  });

  test("while playing, keys move from the playhead as on a music player", async () => {
    const secsAt = async () => Number((await pos())!.match(/^0:(\d+\.\d+)/)![1]);
    await press("]");
    await press("Space");
    await page.waitForTimeout(500);
    // → seeks from the playhead, not from where playback started.
    await press("ArrowRight");
    expect(await secsAt()).toBeGreaterThan(21.2);
    await press("Alt+ArrowLeft"); // back to about 0:06
    await press("PageDown");
    await press("PageDown");
    expect(await secsAt()).toBeGreaterThan(30);

    // Past the first 3 s, [ goes back to the start of the track being played…
    await press("[");
    expect(await pos()).toBe("0:20.000 (00:20:00)");
    expect((await rows()).map((r) => r.selected)).toEqual([false, true, false]);
    // …and within them, to the previous track. ⌃← does the same.
    await press("Control+ArrowLeft");
    expect(await pos()).toBe("0:00.000 (00:00:00)");
    expect((await rows()).map((r) => r.selected)).toEqual([true, false, false]);
  });
});

describe("opening a sheet", () => {
  // The file dialog cannot be driven from a test, so the request that would
  // show it carries a path instead, as if it had been chosen there.
  const choose = (path: string) =>
    page.route("**/api/open", (route) =>
      route.continue({ postData: JSON.stringify({ path }), headers: { ...route.request().headers(), "content-type": "application/json" } }),
    );

  test("an empty page opens a sheet with ⌘O", async () => {
    await server.stop();
    server = await startServer(null);
    await page.goto(server.url);
    await page.waitForSelector("#loading button");
    expect(await page.textContent("#files")).toBe("No cue sheet open");
    expect(await page.title()).toBe("cue-edit");

    await choose(fixture.cue);
    await press("Meta+o");
    await page.waitForSelector("#loading", { state: "hidden" });
    expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);
    expect(await page.title()).toBe("mix.cue");
  });

  test("asks before discarding unsaved split points", async () => {
    const other = await makeFixture(SHEET.replace("INDEX 01 00:40:00", "INDEX 01 00:45:00"));
    try {
      await choose(other.cue);
      await press("]");
      await press("Shift+ArrowRight");
      await press("m");

      // Declining keeps the edit and the sheet.
      page.once("dialog", (d) => d.dismiss());
      await page.click("#open");
      await frames();
      expect(await column(1)).toEqual(["00:00:00", "00:20:01", "00:40:00"]);

      // The page is not reloaded: Safari showed the previous sheet for two
      // seconds while it tore the old page down.
      await page.evaluate(() => ((window as any).samePage = true));
      page.once("dialog", (d) => d.accept());
      await page.click("#open");
      await page.waitForFunction(() => document.querySelector("#track-rows tr:last-child td:nth-child(2)")?.textContent === "00:45:00");
      expect(await page.title()).toBe("mix.cue");
      expect(await column(2)).toEqual(["", "", ""]);
      expect(await indexesOf(fixture.cue)).toEqual(STARTUP_INDEXES);
      expect(await page.evaluate(() => (window as any).samePage)).toBe(true);
      // Nothing of the previous sheet is left: no undo, no edited marks.
      await press("Meta+z");
      expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:45:00"]);
      expect(await page.isDisabled("#save")).toBe(true);
    } finally {
      other.cleanup();
    }
  });

  test("reopens a recent sheet from the empty page and from the menu", async () => {
    const other = await makeFixture(SHEET.replace("INDEX 01 00:40:00", "INDEX 01 00:45:00"));
    try {
      // The fixture sheet was opened at startup; a later run lists it.
      await server.stop({ keepState: true });
      server = await startServer(null, { CUE_EDIT_STATE_DIR: server.stateDir });
      await page.goto(server.url);
      await page.click(".empty .recent-item");
      await page.waitForSelector("#loading", { state: "hidden" });
      expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);

      await choose(other.cue);
      await press("Meta+o");
      await page.waitForFunction(() => document.querySelector("#track-rows tr:last-child td:nth-child(2)")?.textContent === "00:45:00");

      // The menu offers the first sheet (not the open one), and goes back to it.
      await page.unroute("**/api/open");
      await page.click("#recent");
      await page.waitForSelector("#recent-menu .recent-item");
      const items = await page.$$eval("#recent-menu .recent-item", (els) => els.map((el) => el.getAttribute("title")));
      expect(items).toEqual([fixture.cue]);
      await press("Escape");
      expect(await page.isHidden("#recent-menu")).toBe(true);
      await page.click("#recent");
      await page.click("#recent-menu .recent-item");
      await page.waitForFunction(() => document.querySelector("#track-rows tr:last-child td:nth-child(2)")?.textContent === "00:40:00");
    } finally {
      other.cleanup();
    }
  });

  test("reports a sheet that cannot be opened", async () => {
    await choose(`${fixture.dir}/nope.cue`);
    await page.click("#open");
    await page.waitForFunction(() => document.querySelector("#toast")?.classList.contains("error"));
    expect(await page.textContent("#toast")).toContain("Cannot open: cue sheet not found");
    expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);
  });
});

describe("while decoding", () => {
  test("the page works before the audio is decoded", async () => {
    await server.stop();
    server = await startServer(fixture.cue, { CUE_EDIT_READRATE: "10" });
    await openPage();
    // Usable at once: the tracks are listed and split points can be selected.
    expect(await page.isVisible("#progress")).toBe(true);
    expect(await page.textContent("#progress")).toMatch(/^Decoding \d+%$/);
    expect(await column(1)).toEqual(["00:00:00", "00:20:00", "00:40:00"]);
    await press("]");
    expect(await pos()).toBe("0:20.000 (00:20:00)");
    // The progress goes away once decoding is done.
    await page.waitForSelector("#progress", { state: "hidden", timeout: 15000 });
    expect(await page.textContent("#files")).toBe("mix.cue · mix.aac · 1:00.024");
  }, 25000);
});

describe("server lifetime", () => {
  // Pretends the tab went to the background or came back.
  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);

  test("warns when the server has stopped", async () => {
    await press("]");
    await press("Shift+ArrowRight");
    await press("m");
    await server.stop();
    await setHidden(false); // pings at once
    await page.waitForFunction(() => document.title.startsWith("⚠"));
    expect(await page.textContent("#toast")).toBe(
      "The cue-edit server has stopped. 1 unsaved split point cannot be saved. Start cue-edit again and reload.",
    );
    // Saving says the same instead of failing silently.
    await press("Meta+s");
    expect(await page.textContent("#toast")).toContain("server has stopped");
    expect(await page.title()).toBe("⚠ mix.cue");
  });

  test("a hidden page keeps the server alive", async () => {
    await server.stop();
    server = await startServer(fixture.cue, { CUE_EDIT_PING_LIMIT_MS: "1200", CUE_EDIT_HIDDEN_LIMIT_MS: "60000" });
    await openPage();
    await setHidden(true);
    expect(await exitsWithin(server.proc, 3000)).toBe(false);
    await setHidden(false);
    // Visible again, so the short limit applies once the pings stop.
    expect(await exitsWithin(server.proc, 3000)).toBe(true);
  }, 15000);
});
