// Drives the page in headless Chromium against a real server. Needs the
// browser once: `bunx playwright install chromium-headless-shell`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Browser, type Page, chromium } from "playwright";
import { type Fixture, type Server, STARTUP_INDEXES, indexesOf, makeFixture, startServer } from "./helpers";

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

// The page is ready once the decoding notice is gone.
async function openPage() {
  await page.goto(server.url);
  await page.waitForSelector("#loading", { state: "detached" });
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
});
