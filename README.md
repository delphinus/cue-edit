# cue-edit

A small browser-based editor for refining the split points (`INDEX 01`) of a
cue sheet against its audio — typically a DJ mix that is about to be split into
tracks. It runs locally with [Bun](https://bun.sh) and ffmpeg, and is designed
for macOS keyboards and trackpads.

- Opens whatever ffmpeg can decode, including `.m4a` and raw ADTS `.aac`.
- Playback and the waveform come from the same ffmpeg decode, so what you hear
  lines up with what an ffmpeg-based splitter will cut.
- Saving rewrites **only** the digits of `INDEX 01` lines. Line endings, text
  encoding and every other line stay byte-identical, and a `.bak` copy of the
  original sheet is kept next to it.

## Requirements

- Bun 1.1 or later
- `ffmpeg` and `ffprobe` on `PATH`

## Usage

```sh
bun cue-edit.ts [path/to/mix.cue] [--port <n>] [--no-open]
```

The audio named in the sheet's `FILE` line is decoded into a temporary
directory (about 8 seconds for a 2¾-hour mix). The page is usable at once:
the waveform fills in as decoding goes, and playback can go as far as it has
reached (the part not decoded yet is shaded in the overview). The waveform is
kept in `~/.local/state/cue-edit/peaks/` for the last 20 audio files, so a mix
opened before shows all of it straight away; switching back to the sheet open
before does not decode its audio again. The server exits a few seconds after the page is closed and
removes its temporary files.

Without a sheet the page opens empty. The Open button (⌘O) shows the macOS
file dialog, and can also switch to another sheet later; the page asks first
if there are unsaved split points. The dialog is shown by the server with
`osascript`, because a browser gives a page the contents of a file but not its
path, and the server needs the path to find the audio and to save in place.

The last ten sheets opened are listed on the empty page and under ▾ next to
the Open button, and the dialog starts in the folder of the last one. The list
is kept in `~/.local/state/cue-edit/recent.json` (`$XDG_STATE_HOME/cue-edit`
when that is set), so it carries over to the next run.

If the browser does not report the closing, the server exits after five
minutes without a word from a visible page, or twelve hours when the page was
last seen going to the background (Safari stops the timers of background tabs,
so a hidden page cannot keep pinging). Should the server stop while the page
is open, the page says so and how many split points are unsaved.

Only sheets with a single `FILE` line are supported. Tracks cannot be added or
removed; the editor moves existing split points only.

## Keys

| Key | Action |
| --- | --- |
| Space | Play / stop from the cursor |
| 1 2 (F5 F6) | Play the preview length before / from the selection start |
| 3 4 (, .) | Move the selection by one cue frame; with ⇧, ten |
| F7 F8 | Play the preview length before / from the selection end |
| ← → | Move the cursor by the small step (1 s) |
| ⌥← ⌥→, PageUp PageDown | Move the cursor by the large step (15 s) |
| ⇧← ⇧→ | Move the cursor by one cue frame (1/75 s) |
| ↑ ↓ | Cursor to the selection start / end; to the start / end of the file when nothing is selected |
| [ ] | Cursor to the start of the current track (the previous one when already on its split point) / to the next split point, and select it; clears the selection, so 1 and 2 preview around the split point |
| M / ⇧M | Move the selected split point to the selection start / end |
| I O (= −) | Zoom in / out |
| 0 | Show the whole file |
| L | Switch the waveform between the dB and linear scales |
| ⌘Z ⇧⌘Z | Undo / redo |
| ⌘O | Open another cue sheet |
| ⌘S | Save (a notification confirms it) |
| Esc | Cancel a drag, clear the selection |
| ? | Help and settings |

While playing, the cursor keys move from the playhead, as on a music player:
← → seek from where the sound is, and [ goes back to the previous track
instead within the first 3 s of a track.

⌃← ⌃→ also jump between split points, but macOS uses them to switch Spaces
unless that shortcut is turned off in System Settings.

## Mouse and trackpad

| Gesture | Action |
| --- | --- |
| Drag | Select a range; the nearest split point becomes the selected one |
| Click | Move the cursor; a click outside the selection clears it |
| ⇧-click | Extend the selection |
| Drag a handle | Move that split point (the marks above the waveform) |
| ⌥-drag, right-drag | Move the split point nearest to where the drag starts |
| ↑ ↓ while dragging a split point | Drop it on the selection start / end |
| Two-finger scroll | Scroll |
| Pinch | Zoom around the pointer |
| Click / drag the overview | Move the cursor there (the selection is kept); playback continues from it |

A typical refinement: drag over the transition, check it with 1 and 2, adjust
the selection with 3 and 4, then press M to put the split point on the
selection start.

The step sizes and the preview length can be changed in the help dialog (`?`);
they are kept in the browser's local storage.

## Notes

- During playback the playhead stays in the centre and the waveform scrolls
  under it.
- Clicks and drags in the waveform do not interrupt playback; clicking the
  overview jumps playback there.
- Split points are stored in cue frames (1/75 s), the resolution of a cue
  sheet. Selection edges snap to cue frames for the same reason, so a split
  point put on the selection lines up with it exactly.
- As in mp3DirectCut, the overview carries each track's title, and the
  waveform shows the track at the cursor (or the playhead) with the time
  elapsed since its split point in large type, plus the album and
  "Artist - Title" at the bottom.
- The waveform uses a dB scale by default (0 dB at the top, -48 dB at the
  bottom), as mp3DirectCut does, so fades and reverb tails stay visible.
- The waveform is drawn at the same resolution: one bar per cue frame when
  zoomed in, and zooming stops once a cue frame is 32 px wide.
- The Δ column shows how far each split point has moved from the original
  sheet, in seconds. The original is the `.bak` copy when there is one, so the
  values survive saving, reloading the page and restarting cue-edit. Without a
  `.bak` (nothing saved yet) it is the sheet as cue-edit opened it, which is
  what the first save backs up. A `.bak` with a different number of tracks is
  ignored. Delete the `.bak` to start measuring from the current sheet.

## Tests

```sh
bun install
bunx playwright install chromium-headless-shell   # once, for the browser tests
bun test
```

- `lib/cue.test.ts` covers parsing and rewriting cue sheets.
- `test/server.test.ts` starts cue-edit against a generated mix (ffmpeg is
  required) and checks the HTTP API: the sheet and peaks, saving, the `.bak`
  copy and the baseline of the Δ column.
- `test/e2e.test.ts` drives the page in headless Chromium: moving split points
  with the keys and the mouse, undo, saving and reloading.

The same suite runs on GitHub Actions for every push to `main` and every pull
request.

## License

MIT
