import { describe, expect, test } from "bun:test";
import { formatIndex, onlyIndexesChanged, parseCue, rewriteIndexes } from "./cue";

const sample = [
  'PERFORMER "Some DJ"',
  'TITLE "Some Mix"',
  'FILE "mix.aac" WAVE',
  "  TRACK 01 AUDIO",
  '    TITLE "First"',
  '    PERFORMER "Artist A"',
  "    INDEX 01 00:00:00",
  "  TRACK 02 AUDIO",
  '    TITLE "Second"',
  '    PERFORMER "Artist B"',
  "    INDEX 01 03:24:10",
  "  TRACK 03 AUDIO",
  '    TITLE "Third"',
  "    INDEX 01 67:05:74",
  "",
].join("\r\n");

describe("parseCue", () => {
  test("reads header, file and tracks", () => {
    const s = parseCue(sample);
    expect(s.title).toBe("Some Mix");
    expect(s.performer).toBe("Some DJ");
    expect(s.file).toBe("mix.aac");
    expect(s.tracks.map((t) => t.title)).toEqual(["First", "Second", "Third"]);
    expect(s.tracks[1].performer).toBe("Artist B");
    expect(s.tracks.map((t) => t.index)).toEqual([0, (3 * 60 + 24) * 75 + 10, (67 * 60 + 5) * 75 + 74]);
  });

  test("rejects sheets with several FILE lines", () => {
    expect(() => parseCue(`${sample}FILE "b.aac" WAVE\r\n`)).toThrow(/exactly one FILE/);
  });

  test("decodes UTF-8 titles for display", () => {
    const utf8 = Buffer.from(sample.replace("First", "あいう"), "utf8").toString("latin1");
    expect(parseCue(utf8).tracks[0].title).toBe("あいう");
  });
});

describe("formatIndex", () => {
  test("keeps minutes past 59", () => {
    expect(formatIndex((67 * 60 + 5) * 75 + 74)).toBe("67:05:74");
    expect(formatIndex(0)).toBe("00:00:00");
  });
});

describe("rewriteIndexes", () => {
  test("changes only INDEX 01 digits and keeps CRLF", () => {
    const out = rewriteIndexes(sample, [0, 15301, 301949]);
    expect(out).toContain("    INDEX 01 03:24:01\r\n");
    expect(out).toContain("    INDEX 01 67:05:74\r\n");
    expect(out.split("\r\n").length).toBe(sample.split("\r\n").length);
    expect(out.includes("\n") && !/[^\r]\n/.test(out)).toBe(true);
    expect(onlyIndexesChanged(sample, out)).toBe(true);
  });

  test("keeps LF files as LF", () => {
    const lf = sample.replaceAll("\r\n", "\n");
    expect(rewriteIndexes(lf, [0, 1, 2]).includes("\r")).toBe(false);
  });

  test("keeps non-ASCII bytes untouched", () => {
    const latin1 = sample.replace("First", "Caf\xe9");
    const out = rewriteIndexes(latin1, [0, 1, 2]);
    expect(out).toContain("Caf\xe9");
  });

  test("refuses a mismatched number of indexes", () => {
    expect(() => rewriteIndexes(sample, [0, 1])).toThrow(/3 tracks/);
  });
});

describe("onlyIndexesChanged", () => {
  test("detects other edits", () => {
    expect(onlyIndexesChanged(sample, sample.replace("Second", "Other"))).toBe(false);
    expect(onlyIndexesChanged(sample, sample.replaceAll("\r\n", "\n"))).toBe(false);
  });
});
