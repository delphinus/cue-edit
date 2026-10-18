// Cue sheet parsing and in-place rewriting.
//
// The sheet is handled as a latin1 string so that every byte round-trips
// unchanged: only the digits of `INDEX 01` lines are ever rewritten, and line
// endings (CRLF or LF) are kept as they are.

export const CUE_FPS = 75;

export type CueTrack = {
  number: number;
  title: string;
  performer: string;
  // Start time in cue frames (1/75 s).
  index: number;
};

export type CueSheet = {
  title: string;
  performer: string;
  file: string;
  tracks: CueTrack[];
};

const TRACK_RE = /^\s*TRACK\s+(\d+)/i;
const INDEX01_RE = /^(\s*INDEX\s+01\s+)(\d+):(\d{2}):(\d{2})(.*)$/i;
const FILE_RE = /^\s*FILE\s+(?:"([^"]*)"|(\S+))/i;
const TAG_RE = /^\s*(TITLE|PERFORMER)\s+(?:"([^"]*)"|(.*\S))/i;

// Splits into lines while keeping each line's terminator.
function splitLines(text: string): { body: string; eol: string }[] {
  const out: { body: string; eol: string }[] = [];
  const re = /(\r\n|\n|\r)/g;
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ body: text.slice(pos, m.index), eol: m[1] });
    pos = m.index + m[1].length;
  }
  if (pos < text.length) out.push({ body: text.slice(pos), eol: "" });
  return out;
}

export function formatIndex(frames: number): string {
  const ff = frames % CUE_FPS;
  const total = Math.floor(frames / CUE_FPS);
  const ss = total % 60;
  const mm = Math.floor(total / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(mm)}:${p(ss)}:${p(ff)}`;
}

// Decodes tag text for display: UTF-8 when valid, latin1 otherwise.
function displayText(latin1: string): string {
  const bytes = Uint8Array.from(latin1, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin1;
  }
}

export function parseCue(text: string): CueSheet {
  const sheet: CueSheet = { title: "", performer: "", file: "", tracks: [] };
  let files = 0;
  let current: CueTrack | null = null;
  for (const { body } of splitLines(text)) {
    let m: RegExpMatchArray | null;
    if ((m = body.match(FILE_RE))) {
      files++;
      sheet.file = displayText(m[1] ?? m[2]);
    } else if ((m = body.match(TRACK_RE))) {
      current = { number: Number(m[1]), title: "", performer: "", index: -1 };
      sheet.tracks.push(current);
    } else if ((m = body.match(INDEX01_RE))) {
      if (!current) throw new Error("INDEX 01 before any TRACK");
      current.index = (Number(m[2]) * 60 + Number(m[3])) * CUE_FPS + Number(m[4]);
    } else if ((m = body.match(TAG_RE))) {
      const value = displayText(m[2] ?? m[3]);
      const key = m[1].toLowerCase() as "title" | "performer";
      (current ?? sheet)[key] = value;
    }
  }
  if (files !== 1) throw new Error(`expected exactly one FILE line, found ${files}`);
  if (sheet.tracks.length === 0) throw new Error("no TRACK found");
  for (const t of sheet.tracks) {
    if (t.index < 0) throw new Error(`TRACK ${t.number} has no INDEX 01`);
  }
  return sheet;
}

// Returns `text` with the INDEX 01 of each track replaced by `indexes[i]`.
// Everything else, including line endings, stays byte-identical.
export function rewriteIndexes(text: string, indexes: number[]): string {
  const tracks = parseCue(text).tracks.length;
  if (tracks !== indexes.length) {
    throw new Error(`cue has ${tracks} tracks but ${indexes.length} indexes were given`);
  }
  let track = -1;
  return splitLines(text)
    .map(({ body, eol }) => {
      if (TRACK_RE.test(body)) {
        track++;
        return body + eol;
      }
      const m = body.match(INDEX01_RE);
      if (m && track >= 0) return m[1] + formatIndex(indexes[track]) + m[5] + eol;
      return body + eol;
    })
    .join("");
}

// Checks that `after` differs from `before` only in INDEX 01 lines.
export function onlyIndexesChanged(before: string, after: string): boolean {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length !== b.length) return false;
  return a.every((l, i) => {
    if (l.eol !== b[i].eol) return false;
    if (l.body === b[i].body) return true;
    return INDEX01_RE.test(l.body) && INDEX01_RE.test(b[i].body);
  });
}
