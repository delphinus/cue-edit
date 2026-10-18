// cue-edit front end. All positions are in sample frames unless noted;
// split points (cues) are kept in cue frames (1/75 s), exactly as saved.

const CUE_FPS = 75;
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = { small: 1, large: 15, preview: 2 };
const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("cue-edit:settings") || "{}") };

const S = {
  sr: 44100,
  frames: 0,
  block: 256,
  peaks: new Int8Array(0),
  tracks: [],
  cues: [], // cue frames
  loaded: [], // cues as opened (for the Δ column)
  saved: [], // cues as last saved (for the dirty flag)
  selectedCue: -1,
  pos: 0,
  sel: { a: 0, b: 0 },
  view: { start: 0, spp: 1 }, // spp: frames per device pixel of the waveform
  undo: [],
  redo: [],
  drag: null,
  fine: null, // { start, count, data: Int16Array } for deep zoom
  fineWanted: null,
  ready: false,
};

const dpr = () => window.devicePixelRatio || 1;
const cueToFrame = (c) => Math.round((c * S.sr) / CUE_FPS);
const frameToCue = (f) => Math.floor((f * CUE_FPS) / S.sr + 1e-9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const secs = (s) => Math.round(s * S.sr);

function fmtTime(f) {
  const t = Math.max(0, f) / S.sr;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function fmtCue(c) {
  const p = (n) => String(n).padStart(2, "0");
  const total = Math.floor(c / CUE_FPS);
  return `${p(Math.floor(total / 60))}:${p(total % 60)}:${p(c % CUE_FPS)}`;
}

// ---------------------------------------------------------------- playback

class Player {
  constructor() {
    this.ctx = null;
    this.gen = 0;
    this.playing = false;
    this.sources = [];
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: S.sr, latencyHint: "interactive" });
      // Chrome detaches a context that outputs pure silence from the real
      // device, and re-attaching (especially to Bluetooth) delays the next
      // sound by a second or two. An inaudible offset keeps the device open.
      const keepAlive = this.ctx.createConstantSource();
      keepAlive.offset.value = 1e-5; // -100 dBFS
      keepAlive.connect(this.ctx.destination);
      keepAlive.start();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  async chunk(start, count, gen) {
    const res = await fetch(`/api/pcm?start=${start}&count=${count}`);
    const buf = await res.arrayBuffer();
    if (gen !== this.gen) return null;
    const pcm = new Int16Array(buf, 0, buf.byteLength >> 1);
    const n = pcm.length >> 1;
    if (n === 0) return null;
    const audio = this.ctx.createBuffer(2, n, S.sr);
    const l = audio.getChannelData(0);
    const r = audio.getChannelData(1);
    for (let i = 0; i < n; i++) {
      l[i] = pcm[2 * i] / 32768;
      r[i] = pcm[2 * i + 1] / 32768;
    }
    return audio;
  }

  // Plays [from, to). `onEnd` runs when playback reaches `to` by itself.
  async play(from, to, { preview = false, onEnd = null } = {}) {
    this.stop();
    const ctx = this.ensureContext();
    const gen = ++this.gen;
    this.playing = true;
    this.preview = preview;
    this.from = from;
    this.to = Math.min(to, S.frames);
    this.startTime = null;
    let next = from;
    let nextTime = 0;
    let size = Math.min(secs(0.25), this.to - from);
    const pump = async () => {
      while (gen === this.gen && next < this.to && (this.startTime === null || nextTime - ctx.currentTime < 1.5)) {
        const audio = await this.chunk(next, Math.min(size, this.to - next), gen);
        if (!audio) return;
        if (this.startTime === null) {
          this.startTime = ctx.currentTime + 0.03;
          nextTime = this.startTime;
        }
        const src = ctx.createBufferSource();
        src.buffer = audio;
        src.connect(ctx.destination);
        src.start(nextTime);
        this.sources.push(src);
        src.onended = () => (this.sources = this.sources.filter((s) => s !== src));
        nextTime += audio.length / S.sr;
        next += audio.length;
        size = secs(1);
      }
    };
    this.timer = setInterval(() => {
      if (gen !== this.gen) return;
      if (this.startTime !== null && ctx.currentTime >= nextTime && next >= this.to) {
        this.stop();
        onEnd?.();
        return;
      }
      if (!this.pumping) {
        this.pumping = true;
        pump().finally(() => (this.pumping = false));
      }
    }, 50);
    this.pumping = true;
    await pump().finally(() => (this.pumping = false));
  }

  position() {
    if (!this.playing) return null;
    if (this.startTime === null) return this.from;
    // contextTime is the time of the sample leaving the device when
    // performanceTime was taken; extrapolate it to now, since it only moves in
    // render-quantum steps.
    const ts = this.ctx.getOutputTimestamp?.();
    let now;
    if (ts?.contextTime > 0) now = ts.contextTime + Math.max(0, (performance.now() - ts.performanceTime) / 1000);
    else now = this.ctx.currentTime - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0);
    const t = now - this.startTime;
    return clamp(this.from + Math.round(t * S.sr), this.from, this.to);
  }

  stop() {
    const pos = this.position();
    this.gen++;
    this.playing = false;
    clearInterval(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources = [];
    return pos;
  }
}

const player = new Player();

function togglePlay() {
  if (player.playing) {
    const wasPreview = player.preview;
    const at = player.stop();
    if (!wasPreview && at !== null) S.pos = at;
  } else {
    player.play(S.pos, S.frames, { onEnd: () => (S.pos = S.frames) });
  }
  draw();
}

function preview(which) {
  const { a, b } = selOrCursor();
  const len = secs(settings.preview);
  const ranges = [
    [a - len, a],
    [a, a + len],
    [b - len, b],
    [b, b + len],
  ];
  const [from, to] = ranges[which];
  player.play(Math.max(0, from), to, { preview: true, onEnd: draw });
  draw();
}

// Jumps the cursor; keeps normal playback going from the new place.
function setPos(f, { follow = true } = {}) {
  S.pos = clamp(Math.round(f), 0, S.frames);
  if (player.playing && !player.preview) player.play(S.pos, S.frames, { onEnd: () => (S.pos = S.frames) });
  if (follow) ensureVisible(S.pos);
  draw();
}

// ---------------------------------------------------------------- editing

const selOrCursor = () => (S.sel.b > S.sel.a ? S.sel : { a: S.pos, b: S.pos });

function pushUndo() {
  S.undo.push({ cues: [...S.cues], selectedCue: S.selectedCue });
  if (S.undo.length > 500) S.undo.shift();
  S.redo = [];
}

function restore(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push({ cues: [...S.cues], selectedCue: S.selectedCue });
  S.cues = snap.cues;
  S.selectedCue = snap.selectedCue;
  renderTracks();
  draw();
}

// Clamps a cue so that split points stay in order.
function clampCue(i, c) {
  const lo = i > 0 ? S.cues[i - 1] + 1 : 0;
  const hi = i < S.cues.length - 1 ? S.cues[i + 1] - 1 : frameToCue(S.frames);
  return clamp(c, lo, hi);
}

function moveCue(i, frame, { undo = true } = {}) {
  if (i < 0) return;
  const c = clampCue(i, frameToCue(frame));
  if (c === S.cues[i]) return;
  if (undo) pushUndo();
  S.cues[i] = c;
  renderTracks();
  draw();
}

function selectCue(i, { jump = true } = {}) {
  S.selectedCue = i;
  if (jump && i >= 0) setPos(cueToFrame(S.cues[i]));
  renderTracks();
  draw();
}

function neighbourCue(dir) {
  const here = frameToCue(S.pos);
  if (dir < 0) {
    for (let i = S.cues.length - 1; i >= 0; i--) if (S.cues[i] < here) return i;
    return 0;
  }
  for (let i = 0; i < S.cues.length; i++) if (S.cues[i] > here) return i;
  return S.cues.length - 1;
}

function nudgeSelection(frames) {
  if (S.sel.b > S.sel.a) {
    const len = S.sel.b - S.sel.a;
    const a = clamp(S.sel.a + frames, 0, S.frames - len);
    S.sel = { a, b: a + len };
    S.pos = a;
    ensureVisible(a);
    draw();
  } else {
    setPos(S.pos + frames);
  }
}

const isDirty = () => S.cues.some((c, i) => c !== S.saved[i]);

async function save() {
  if (!isDirty()) return;
  setStatus("Saving…");
  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ indexes: S.cues }),
  });
  const body = await res.json();
  if (!res.ok) {
    setStatus(`Save failed: ${body.error}`);
    return;
  }
  S.saved = [...S.cues];
  setStatus(`Saved ${new Date().toLocaleTimeString()}`);
  renderTracks();
  draw();
}

let statusTimer;
function setStatus(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 6000);
}

// ---------------------------------------------------------------- view

const canvases = {
  overview: $("overview"),
  strip: $("strip"),
  wave: $("wave"),
  overlay: $("overlay"),
};

function resize() {
  for (const c of Object.values(canvases)) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr()));
    c.height = Math.max(1, Math.round(r.height * dpr()));
  }
  overviewImage = null;
  clampView();
  drawWave();
  draw();
}

const waveWidth = () => canvases.wave.width;
const viewEnd = () => S.view.start + waveWidth() * S.view.spp;
const xOf = (f) => (f - S.view.start) / S.view.spp;
const frameAtX = (x) => clamp(Math.round(S.view.start + x * S.view.spp), 0, S.frames);
const maxSpp = () => Math.max(1, S.frames / waveWidth());

// The view may run half a screen past either end of the file, so that the
// playhead can stay centred there too. Snapping the start to whole pixels
// keeps each column on the same frames while the waveform scrolls.
function clampView() {
  S.view.spp = clamp(S.view.spp, 1, maxSpp());
  const half = (waveWidth() * S.view.spp) / 2;
  const start = clamp(S.view.start, -half, Math.max(-half, S.frames - half));
  S.view.start = Math.round(start / S.view.spp) * S.view.spp;
}

function setView(start, spp) {
  const prev = S.view;
  S.view = { start, spp };
  clampView();
  if (S.view.start !== prev.start || S.view.spp !== prev.spp) drawWave();
  draw();
}

function zoomAround(frame, factor) {
  const x = xOf(frame);
  const spp = clamp(S.view.spp * factor, 1, maxSpp());
  setView(frame - x * spp, spp);
}

function zoomKey(factor) {
  const anchor = S.pos >= S.view.start && S.pos <= viewEnd() ? S.pos : (S.view.start + viewEnd()) / 2;
  zoomAround(anchor, factor);
}

function centerOn(f) {
  setView(f - (waveWidth() * S.view.spp) / 2, S.view.spp);
}

function ensureVisible(f) {
  const margin = (viewEnd() - S.view.start) * 0.05;
  if (f < S.view.start + margin || f > viewEnd() - margin) centerOn(f);
}

// ---------------------------------------------------------------- drawing

const COLORS = {
  wave: "#5b9bd5",
  waveFine: "#7fb3e3",
  sel: "rgba(240, 180, 41, 0.22)",
  cursor: "#ffffff",
  playhead: "#5ce07a",
  cue: "rgba(255, 120, 120, 0.75)",
  cueEdited: "#f0b429",
  cueSelected: "#ff5c5c",
  text: "#d8dbe2",
  dim: "#7d8390",
};

function wantFine() {
  if (S.view.spp >= S.block) return null;
  const span = waveWidth() * S.view.spp;
  const need0 = Math.max(0, S.view.start);
  const need1 = Math.min(S.frames, viewEnd());
  const start = Math.max(0, Math.floor(need0 - span));
  const count = Math.ceil(span * 3);
  const f = S.fine;
  const covers = f && f.start <= need0 && f.start + f.count >= need1;
  // Fetch the next window before the view runs off this one (e.g. while the
  // waveform scrolls under the playhead), so the fine view never drops out.
  const runningOut = f && f.start + f.count < Math.min(S.frames, need1 + span);
  if (covers && !runningOut) return f;
  if (!S.fineWanted || (!covers && S.fineWanted.start !== start)) {
    S.fineWanted = { start, count };
    fetch(`/api/pcm?start=${start}&count=${count}`)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (S.fineWanted?.start !== start) return;
        const data = new Int16Array(buf, 0, buf.byteLength >> 1);
        S.fine = { start, count: data.length >> 1, data };
        S.fineWanted = null;
        drawWave();
      });
  }
  return covers ? f : null;
}

function columnRange(f0, f1, fine) {
  let lo = 127;
  let hi = -128;
  if (fine) {
    const a = Math.max(fine.start, Math.floor(f0));
    const b = Math.min(fine.start + fine.count, Math.max(a + 1, Math.ceil(f1)));
    for (let f = a; f < b; f++) {
      const i = (f - fine.start) * 2;
      const l = fine.data[i] >> 8;
      const r = fine.data[i + 1] >> 8;
      if (l < lo) lo = l;
      if (r < lo) lo = r;
      if (l > hi) hi = l;
      if (r > hi) hi = r;
    }
  } else {
    const p = S.peaks;
    const b0 = Math.floor(f0 / S.block);
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / S.block));
    for (let b = b0; b < b1 && 2 * b + 1 < p.length; b++) {
      if (p[2 * b] < lo) lo = p[2 * b];
      if (p[2 * b + 1] > hi) hi = p[2 * b + 1];
    }
  }
  return hi < lo ? null : [lo, hi];
}

function drawWave() {
  const c = canvases.wave;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  if (!S.ready) return;
  const fine = wantFine();
  const mid = c.height / 2;
  const scale = (c.height / 2 - 2) / 128;
  g.fillStyle = fine ? COLORS.waveFine : COLORS.wave;
  for (let x = 0; x < c.width; x++) {
    const f0 = S.view.start + x * S.view.spp;
    if (f0 >= S.frames) break;
    const r = columnRange(f0, f0 + S.view.spp, fine);
    if (!r) continue;
    const top = mid - r[1] * scale;
    const bottom = mid - r[0] * scale;
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(0, mid, c.width, 1);
}

let overviewImage = null;
function drawOverview() {
  const c = canvases.overview;
  const g = c.getContext("2d");
  if (!S.ready) {
    g.clearRect(0, 0, c.width, c.height);
    return;
  }
  if (!overviewImage) {
    overviewImage = document.createElement("canvas");
    overviewImage.width = c.width;
    overviewImage.height = c.height;
    const o = overviewImage.getContext("2d");
    const spp = S.frames / c.width;
    const mid = c.height / 2;
    const scale = (c.height / 2 - 2) / 128;
    o.fillStyle = "#3d6a94";
    for (let x = 0; x < c.width; x++) {
      const r = columnRange(x * spp, (x + 1) * spp, null);
      if (!r) continue;
      o.fillRect(x, mid - r[1] * scale, 1, Math.max(1, (r[1] - r[0]) * scale));
    }
  }
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(overviewImage, 0, 0);
  const k = c.width / S.frames;
  g.fillStyle = "rgba(255,255,255,0.12)";
  g.strokeStyle = "rgba(255,255,255,0.5)";
  const vx = S.view.start * k;
  const vw = Math.max(2, (viewEnd() - S.view.start) * k);
  g.fillRect(vx, 0, vw, c.height);
  g.strokeRect(vx + 0.5, 0.5, vw - 1, c.height - 1);
  S.cues.forEach((cue, i) => {
    g.fillStyle = cueColor(i);
    g.fillRect(Math.round(cueToFrame(cue) * k), 0, 1, c.height);
  });
  const ph = head;
  g.fillStyle = ph !== null ? COLORS.playhead : COLORS.cursor;
  g.fillRect(Math.round((ph ?? S.pos) * k), 0, 1, c.height);
}

function cueColor(i) {
  if (i === S.selectedCue) return COLORS.cueSelected;
  if (S.cues[i] !== S.loaded[i]) return COLORS.cueEdited;
  return COLORS.cue;
}

const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
const RULER_H = 18;

function drawStrip() {
  const c = canvases.strip;
  const g = c.getContext("2d");
  const d = dpr();
  g.clearRect(0, 0, c.width, c.height);
  if (!S.ready) return;
  const pxPerSec = S.sr / S.view.spp / d; // CSS px per second
  const step = TICKS.find((t) => t * pxPerSec >= 90) ?? TICKS.at(-1);
  g.font = `${11 * d}px -apple-system, sans-serif`;
  g.fillStyle = COLORS.dim;
  g.textBaseline = "top";
  const t0 = Math.max(0, Math.floor(S.view.start / S.sr / step) * step);
  for (let t = t0; t * S.sr <= viewEnd(); t += step) {
    const x = Math.round(xOf(t * S.sr));
    g.fillRect(x, 0, 1, 5 * d);
    const label = step < 1 ? fmtTime(secs(t)) : fmtTime(secs(t)).replace(/\.000$/, "");
    g.fillText(label, x + 3 * d, 2 * d);
  }
  const y0 = RULER_H * d;
  g.textBaseline = "middle";
  S.cues.forEach((cue, i) => {
    const x = Math.round(xOf(cueToFrame(cue)));
    if (x < -30 * d || x > c.width + 30 * d) return;
    g.fillStyle = cueColor(i);
    const w = 9 * d;
    g.beginPath();
    g.moveTo(x - w / 2, y0);
    g.lineTo(x + w / 2, y0);
    g.lineTo(x + w / 2, c.height - 8 * d);
    g.lineTo(x, c.height);
    g.lineTo(x - w / 2, c.height - 8 * d);
    g.closePath();
    g.fill();
    g.fillStyle = COLORS.text;
    g.fillText(String(S.tracks[i].number), x + w / 2 + 3 * d, (y0 + c.height) / 2);
  });
}

function drawOverlay() {
  const c = canvases.overlay;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  if (!S.ready) return;
  const d = dpr();
  if (S.sel.b > S.sel.a) {
    const x0 = xOf(S.sel.a);
    const x1 = xOf(S.sel.b);
    g.fillStyle = COLORS.sel;
    g.fillRect(x0, 0, Math.max(1, x1 - x0), c.height);
  }
  S.cues.forEach((cue, i) => {
    const x = Math.round(xOf(cueToFrame(cue)));
    if (x < 0 || x > c.width) return;
    g.fillStyle = cueColor(i);
    g.fillRect(x, 0, i === S.selectedCue ? 2 * d : d, c.height);
  });
  g.fillStyle = COLORS.cursor;
  g.fillRect(Math.round(xOf(S.pos)), 0, d, c.height);
  const ph = head;
  if (ph !== null) {
    g.fillStyle = COLORS.playhead;
    g.fillRect(Math.round(xOf(ph)), 0, d, c.height);
  }
}

function updateReadout() {
  $("pos").textContent = `${fmtTime(S.pos)} (${fmtCue(frameToCue(S.pos))})`;
  $("sel").textContent =
    S.sel.b > S.sel.a ? `${fmtTime(S.sel.a)} – ${fmtTime(S.sel.b)} (${((S.sel.b - S.sel.a) / S.sr).toFixed(3)} s)` : "-";
  $("zoom").textContent = `${((viewEnd() - S.view.start) / S.sr).toFixed(2)} s`;
  const dirty = isDirty();
  $("save").disabled = !dirty;
  document.title = `${dirty ? "● " : ""}${S.cueName ?? "cue-edit"}`;
}

let currentRow = -1;
function updateCurrentRow() {
  const here = frameToCue(head ?? S.pos);
  let cur = -1;
  for (let i = 0; i < S.cues.length && S.cues[i] <= here; i++) cur = i;
  if (cur === currentRow) return;
  const rows = $("track-rows").children;
  rows[currentRow]?.classList.remove("current");
  rows[cur]?.classList.add("current");
  currentRow = cur;
}

// Playhead for the frame being drawn. Read once per frame: the output clock
// advances between calls, and the scroll and the line must agree.
let head = null;
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    head = player.position();
    const ph = head;
    if (ph !== null && !player.preview && !S.drag) {
      // Keep the playhead centred and scroll the waveform under it.
      setView(ph - (waveWidth() * S.view.spp) / 2, S.view.spp);
    }
    drawOverlay();
    drawStrip();
    drawOverview();
    updateReadout();
    updateCurrentRow();
    if (player.playing) draw();
  });
}

function renderTracks() {
  const body = $("track-rows");
  body.replaceChildren(
    ...S.tracks.map((t, i) => {
      const tr = document.createElement("tr");
      const delta = (S.cues[i] - S.loaded[i]) / CUE_FPS;
      if (S.cues[i] !== S.loaded[i]) tr.classList.add("edited");
      if (i === S.selectedCue) tr.classList.add("selected");
      const name = [t.performer, t.title].filter(Boolean).join(" – ");
      for (const text of [t.number, fmtCue(S.cues[i]), delta ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)}` : "", name]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      tr.addEventListener("click", () => selectCue(i));
      return tr;
    }),
  );
  currentRow = -1;
  body.children[S.selectedCue]?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- mouse

// Synthetic pointer events (tests) cannot be captured.
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {}
}

const devX = (e, el) => (e.clientX - el.getBoundingClientRect().left) * dpr();

function nearestCue(frame) {
  let best = -1;
  let dist = Infinity;
  S.cues.forEach((c, i) => {
    const d = Math.abs(cueToFrame(c) - frame);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

function startCueDrag(i, e, el) {
  S.drag = { kind: "cue", i, orig: S.cues[i], el, pointerId: e.pointerId };
  S.selectedCue = i;
  capture(el, e.pointerId);
  renderTracks();
  draw();
}

function endCueDrag(commit) {
  const d = S.drag;
  if (!d || d.kind !== "cue") return;
  S.drag = null;
  const moved = S.cues[d.i];
  S.cues[d.i] = d.orig;
  if (commit && moved !== d.orig) {
    pushUndo();
    S.cues[d.i] = moved;
  }
  if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
  renderTracks();
  draw();
}

const overlay = canvases.overlay;
overlay.addEventListener("contextmenu", (e) => e.preventDefault());
canvases.strip.addEventListener("contextmenu", (e) => e.preventDefault());

overlay.addEventListener("pointerdown", (e) => {
  if (!S.ready) return;
  const f = frameAtX(devX(e, overlay));
  if (e.button === 2 || (e.button === 0 && e.altKey)) {
    startCueDrag(nearestCue(f), e, overlay);
    return;
  }
  if (e.button !== 0) return;
  capture(overlay, e.pointerId);
  if (e.shiftKey && S.sel.b > S.sel.a) {
    const anchor = Math.abs(f - S.sel.a) < Math.abs(f - S.sel.b) ? S.sel.b : S.sel.a;
    S.drag = { kind: "select", anchor, x: e.clientX, moved: true };
    S.sel = { a: Math.min(anchor, f), b: Math.max(anchor, f) };
  } else {
    // The selection is left alone until the pointer moves or is released, so
    // that a click inside it keeps it (see clickAt).
    S.drag = { kind: "select", anchor: f, x: e.clientX, moved: false };
  }
  draw();
});

overlay.addEventListener("pointermove", (e) => {
  const d = S.drag;
  if (!d) {
    overlay.style.cursor = e.altKey ? "ew-resize" : "text";
    return;
  }
  const f = frameAtX(devX(e, overlay));
  if (d.kind === "cue") {
    S.cues[d.i] = clampCue(d.i, frameToCue(f));
  } else if (d.kind === "select") {
    if (Math.abs(e.clientX - d.x) > 2) d.moved = true;
    if (!d.moved) return;
    S.sel = { a: Math.min(d.anchor, f), b: Math.max(d.anchor, f) };
    S.pos = S.sel.a;
  }
  renderTracksSoon();
  draw();
});

overlay.addEventListener("pointerup", () => {
  const d = S.drag;
  if (!d) return;
  if (d.kind === "cue") return endCueDrag(true);
  S.drag = null;
  if (!d.moved) return clickAt(d.anchor);
  // A new selection usually brackets a transition: pick the split point
  // nearest to it so that M (or ↑ while dragging) acts on it right away.
  S.selectedCue = nearestCue(S.sel.a);
  renderTracks();
  setPos(S.sel.a, { follow: false });
});

// A click moves the cursor; outside the selection it also clears it.
function clickAt(f) {
  if (f < S.sel.a || f > S.sel.b) S.sel = { a: f, b: f };
  setPos(f, { follow: false });
}

let renderQueued = false;
function renderTracksSoon() {
  if (renderQueued || S.drag?.kind !== "cue") return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    renderTracks();
  }, 100);
}

const strip = canvases.strip;
strip.addEventListener("pointerdown", (e) => {
  if (!S.ready) return;
  const x = devX(e, strip);
  let hit = -1;
  let dist = 8 * dpr();
  S.cues.forEach((c, i) => {
    const d = Math.abs(xOf(cueToFrame(c)) - x);
    if (d <= dist) {
      dist = d;
      hit = i;
    }
  });
  if (hit >= 0) startCueDrag(hit, e, strip);
  else if (e.button === 0) clickAt(frameAtX(x));
});
strip.addEventListener("pointermove", (e) => {
  if (S.drag?.kind !== "cue") return;
  const d = S.drag;
  S.cues[d.i] = clampCue(d.i, frameToCue(frameAtX(devX(e, strip))));
  renderTracksSoon();
  draw();
});
strip.addEventListener("pointerup", () => endCueDrag(true));

const overview = canvases.overview;
const overviewFrame = (e) => clamp((devX(e, overview) / overview.width) * S.frames, 0, S.frames);

// Clicking the overview moves the cursor there (playback continues from it).
// While dragging, only the view and the cursor follow; playback restarts once
// on release instead of on every move.
overview.addEventListener("pointerdown", (e) => {
  if (!S.ready || e.button !== 0) return;
  capture(overview, e.pointerId);
  S.drag = { kind: "overview" };
  clickAt(Math.round(overviewFrame(e)));
  centerOn(S.pos);
});
overview.addEventListener("pointermove", (e) => {
  if (S.drag?.kind !== "overview") return;
  S.drag.moved = true;
  S.pos = Math.round(overviewFrame(e));
  centerOn(S.pos);
});
overview.addEventListener("pointerup", () => {
  const moved = S.drag?.kind === "overview" && S.drag.moved;
  S.drag = null;
  if (moved) setPos(S.pos, { follow: false });
});

function onWheel(e) {
  if (!S.ready) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey) {
    const target = e.currentTarget === overview ? overlay : e.currentTarget;
    zoomAround(frameAtX(devX(e, target)), Math.exp(e.deltaY * unit * 0.01));
    return;
  }
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  setView(S.view.start + delta * unit * dpr() * S.view.spp, S.view.spp);
}
for (const el of [overlay, strip, overview]) el.addEventListener("wheel", onWheel, { passive: false });

// ---------------------------------------------------------------- keyboard

// With a Japanese IME on, `key` is "Process"; fall back to the physical key.
const CODE_KEYS = { Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Slash: "?", Equal: "=", Minus: "-" };

// Normalizes to a `code`-style name, preferring `key` so that the layout the
// user types on decides; `code` is used only when `key` says nothing useful
// (an IME swallowing it, or ⇧ turning a digit into a symbol).
function codeOf(e) {
  if (/^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
  if (/^[0-9]$/.test(e.key)) return `Digit${e.key}`;
  if (e.key === " ") return "Space";
  if (/^(Arrow\w+|F\d+|Page\w+|Escape)$/.test(e.key)) return e.key;
  return e.code;
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || $("help").open) return;
  if (!S.ready) return;
  const key = e.key === "Process" || e.isComposing ? CODE_KEYS[e.code] ?? e.code : e.key;
  const code = codeOf(e);
  const step = (s) => secs(s);
  let handled = true;

  if (e.metaKey) {
    if (code === "KeyS") save();
    else if (code === "KeyZ") e.shiftKey ? restore(S.redo, S.undo) : restore(S.undo, S.redo);
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }

  // While a split point is being dragged, ↑ / ↓ drop it on the selection edges.
  if (S.drag?.kind === "cue") {
    const { a, b } = selOrCursor();
    if (code === "ArrowUp") S.cues[S.drag.i] = clampCue(S.drag.i, frameToCue(a));
    else if (code === "ArrowDown") S.cues[S.drag.i] = clampCue(S.drag.i, frameToCue(b));
    if (code === "ArrowUp" || code === "ArrowDown") endCueDrag(true);
    else if (code === "Escape") endCueDrag(false);
    e.preventDefault();
    return;
  }

  switch (code) {
    case "Space":
      togglePlay();
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      const dir = code === "ArrowLeft" ? -1 : 1;
      if (e.ctrlKey) selectCue(neighbourCue(dir));
      else if (e.altKey) setPos(S.pos + dir * step(settings.large));
      else if (e.shiftKey) setPos(cueToFrame(frameToCue(S.pos) + dir));
      else setPos(S.pos + dir * step(settings.small));
      break;
    }
    case "PageUp":
    case "PageDown":
      setPos(S.pos + (code === "PageUp" ? -1 : 1) * step(settings.large));
      break;
    // Selection edges, or the ends of the file when nothing is selected.
    case "ArrowUp":
      setPos(S.sel.b > S.sel.a ? S.sel.a : 0);
      break;
    case "ArrowDown":
      setPos(S.sel.b > S.sel.a ? S.sel.b : S.frames);
      break;
    case "F5":
    case "F6":
    case "F7":
    case "F8":
      preview(Number(code[1]) - 5);
      break;
    case "Digit1":
    case "Digit2":
    case "Digit3":
    case "Digit4":
      preview(Number(code[5]) - 1);
      break;
    case "Digit5":
    case "Digit6":
      nudgeSelection((code === "Digit5" ? -1 : 1) * (e.shiftKey ? 10 : 1) * (S.sr / CUE_FPS));
      break;
    case "Digit0":
      setView(0, maxSpp());
      break;
    case "KeyI":
      zoomKey(0.5);
      break;
    case "KeyO":
      zoomKey(2);
      break;
    case "KeyM": {
      const { a, b } = selOrCursor();
      moveCue(S.selectedCue, e.shiftKey ? b : a);
      break;
    }
    case "Escape":
      S.sel = { a: S.pos, b: S.pos };
      draw();
      break;
    default:
      handled = false;
  }

  if (!handled) {
    handled = true;
    switch (key) {
      case ",":
      case "<":
      case ".":
      case ">":
        nudgeSelection((key === "," || key === "<" ? -1 : 1) * (e.shiftKey ? 10 : 1) * (S.sr / CUE_FPS));
        break;
      case "[":
        selectCue(neighbourCue(-1));
        break;
      case "]":
        selectCue(neighbourCue(1));
        break;
      case "=":
      case "+":
        zoomKey(0.5);
        break;
      case "-":
        zoomKey(2);
        break;
      case "?":
        openHelp();
        break;
      default:
        handled = false;
    }
  }
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------- help & settings

function openHelp() {
  const form = $("settings");
  for (const k of Object.keys(DEFAULT_SETTINGS)) form.elements[k].value = settings[k];
  $("help").showModal();
}
$("help-button").addEventListener("click", openHelp);
$("settings").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (v > 0) {
    settings[e.target.name] = v;
    localStorage.setItem("cue-edit:settings", JSON.stringify(settings));
  }
});
$("save").addEventListener("click", save);

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) e.preventDefault();
});
window.addEventListener("pagehide", () => navigator.sendBeacon("/api/bye"));

// Open the audio device on the first gesture (autoplay rules require one), so
// that the first Space does not wait for it. Release it while the tab is hidden.
for (const type of ["pointerdown", "keydown"]) {
  window.addEventListener(type, () => player.ensureContext(), { once: true, capture: true });
}
document.addEventListener("visibilitychange", () => {
  if (!player.ctx) return;
  if (document.hidden && !player.playing) player.ctx.suspend();
  else if (!document.hidden) player.ctx.resume();
});
window.addEventListener("resize", resize);

// ---------------------------------------------------------------- start

async function load() {
  let info;
  for (;;) {
    info = await (await fetch("/api/info")).json();
    if (info.done) break;
    $("loading").textContent = `Decoding… ${(info.frames / info.sampleRate).toFixed(0)} s`;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (info.error) {
    $("loading").textContent = `Decoding failed: ${info.error}`;
    return;
  }
  S.sr = info.sampleRate;
  S.frames = info.frames;
  S.block = info.block;
  S.tracks = info.tracks;
  S.cues = info.tracks.map((t) => t.index);
  S.loaded = [...S.cues];
  S.saved = [...S.cues];
  S.cueName = info.cueName;
  S.peaks = new Int8Array(await (await fetch("/api/peaks")).arrayBuffer());
  $("title").textContent = [info.performer, info.title].filter(Boolean).join(" – ") || info.cueName;
  $("files").textContent = `${info.cueName} · ${info.audioName} · ${fmtTime(info.frames)}`;
  $("loading").remove();
  S.ready = true;
  resize();
  setView(0, maxSpp());
  renderTracks();
}

resize();
load();
