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
bun cue-edit.ts path/to/mix.cue [--port <n>] [--no-open]
```

The audio named in the sheet's `FILE` line is decoded once into a temporary
directory (about 5 seconds for a 70-minute mix), then the page opens in the
default browser. The server exits a few seconds after the page is closed and
removes its temporary files.

Only sheets with a single `FILE` line are supported. Tracks cannot be added or
removed; the editor moves existing split points only.

## Keys

| Key | Action |
| --- | --- |
| Space | Play / stop from the cursor |
| 1 2 3 4 (F5–F8) | Play the preview length before / from the selection start, before / from the selection end |
| ← → | Move the cursor by the small step (1 s) |
| ⌥← ⌥→, PageUp PageDown | Move the cursor by the large step (15 s) |
| ⇧← ⇧→ | Move the cursor by one cue frame (1/75 s) |
| ↑ ↓ | Cursor to the selection start / end; to the start / end of the file when nothing is selected |
| [ ] | Cursor to the previous / next split point and select it; clears the selection, so 1–4 preview around the split point |
| , . (5 6) | Move the selection by one cue frame; with ⇧, ten |
| M / ⇧M | Move the selected split point to the selection start / end |
| I O (= −) | Zoom in / out |
| 0 | Show the whole file |
| ⌘Z ⇧⌘Z | Undo / redo |
| ⌘S | Save (a notification confirms it) |
| Esc | Cancel a drag, clear the selection |
| ? | Help and settings |

⌃← ⌃→ also jump between split points, but macOS uses them to switch Spaces
unless that shortcut is turned off in System Settings.

## Mouse and trackpad

| Gesture | Action |
| --- | --- |
| Drag | Select a range; the nearest split point becomes the selected one |
| Click | Move the cursor; a click outside the selection clears it |
| ⇧-click | Extend the selection |
| Drag a numbered handle | Move that split point |
| ⌥-drag, right-drag | Move the split point nearest to where the drag starts |
| ↑ ↓ while dragging a split point | Drop it on the selection start / end |
| Two-finger scroll | Scroll |
| Pinch | Zoom around the pointer |
| Click / drag the overview | Move the cursor there (the selection is kept); playback continues from it |

A typical refinement: drag over the transition, check it with 1 and 2, adjust
the selection with `,` and `.`, then press M to put the split point on the
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
- The waveform is drawn at the same resolution: one bar per cue frame when
  zoomed in, and zooming stops once a cue frame is 32 px wide.
- The Δ column shows how far each split point has moved since the sheet was
  opened, in seconds.

## License

MIT
