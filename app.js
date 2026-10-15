/* Madder PDF signer. Everything happens in this page: pdf.js draws the pages, pdf-lib writes the signed copy.
 * Items are kept in DISPLAY points (the page as shown, rotation applied, scale 1) and converted to PDF user space with the
 * pdf.js viewport at export time, so rotated and offset pages need no special cases. A drawn signature is written as vector
 * strokes (no image), a typed one as Helvetica text. */
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const $ = (id) => document.getElementById(id);
const S = { bytes: null, name: '', pdf: null, pages: [], items: [], sel: null, armed: null, mode: 'draw', nextId: 1 };

/* ------------------------------------------------------------------ signature pad */
const pad = { strokes: [], cur: null };
const padc = $('padc'), pctx = padc.getContext('2d');
function padSize() {
  const r = padc.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  if (!r.width) return;
  padc.width = Math.round(r.width * d); padc.height = Math.round(r.height * d); pctx.setTransform(d, 0, 0, d, 0, 0); padDraw();
}
function smooth(ctx, pts) {   // quadratic through the midpoints: the same curve the export writes
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) { ctx.lineTo(pts[0].x + 0.01, pts[0].y); return; }
  for (let i = 1; i < pts.length - 1; i++) { const m = mid(pts[i], pts[i + 1]); ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y); }
  const l = pts[pts.length - 1]; ctx.lineTo(l.x, l.y);
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const PAD_LW = 2.4;
function padDraw() {
  const r = padc.getBoundingClientRect(); pctx.clearRect(0, 0, r.width, r.height);
  pctx.strokeStyle = $('ink').value; pctx.lineWidth = PAD_LW; pctx.lineCap = 'round'; pctx.lineJoin = 'round';
  for (const s of pad.strokes) { pctx.beginPath(); smooth(pctx, s); pctx.stroke(); }
  $('padph').style.display = pad.strokes.length ? 'none' : '';
}
function padPt(e) { const r = padc.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
padc.addEventListener('pointerdown', (e) => { e.preventDefault(); try { padc.setPointerCapture(e.pointerId); } catch (_) {} pad.cur = [padPt(e)]; pad.strokes.push(pad.cur); padDraw(); });
padc.addEventListener('pointermove', (e) => {
  if (!pad.cur) return;
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; if (!evs.length) evs = [e];
  for (const ev of evs) { const p = padPt(ev), l = pad.cur[pad.cur.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) >= 1.2) pad.cur.push(p); }
  padDraw();
});
const padEnd = () => { if (pad.cur) { pad.cur = null; sigChanged(); } };
padc.addEventListener('pointerup', padEnd); padc.addEventListener('pointercancel', padEnd);
$('undo').onclick = () => { pad.strokes.pop(); padDraw(); sigChanged(); };
$('clear').onclick = () => { pad.strokes = []; padDraw(); sigChanged(); };
$('ink').onchange = () => { padDraw(); S.items.forEach(renderItem); };

/** The drawn signature trimmed to its ink: strokes in 0..1 of the box, aspect, stroke width as a fraction of the height. */
function drawnSig() {
  const pts = pad.strokes.flat(); if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const m = PAD_LW; x0 -= m; y0 -= m; x1 += m; y1 += m;
  const w = Math.max(x1 - x0, 8), h = Math.max(y1 - y0, 8);
  if (pts.length < 4 || (w < 20 && h < 12)) return null;   // a stray click is not a signature
  return { strokes: pad.strokes.map((s) => s.map((p) => ({ x: (p.x - x0) / w, y: (p.y - y0) / h }))), aspect: w / h, lw: PAD_LW / h };
}

/* ------------------------------------------------------------------ typed signature */
function typedText() { return $('typed').value.trim(); }
function typedCheck() {
  const t = typedText(), msg = $('typedmsg');
  $('typedprev').textContent = t; $('typedprev').style.color = $('ink').value;
  msg.className = 'msg'; msg.textContent = '';
  if (!t) return false;
  if ($('slash').checked && !/^\/[^/].*[^/]\/$|^\/[^/]\/$/.test(t)) {
    msg.className = 'msg bad';
    msg.textContent = 'An /S/ signature is your name between two slashes, typed by you: /' + t.replace(/^\/+|\/+$/g, '') + '/';
    return false;
  }
  msg.className = 'msg ok'; msg.textContent = 'Ready to place.'; return true;
}
$('typed').oninput = () => { typedCheck(); sigChanged(); };
$('slash').onchange = () => { typedCheck(); sigChanged(); };

document.querySelectorAll('#mode button').forEach((b) => b.onclick = () => {
  S.mode = b.dataset.m; document.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('on', x === b));
  $('drawbox').hidden = S.mode !== 'draw'; $('typebox').hidden = S.mode !== 'type';
  if (S.mode === 'draw') padSize(); else $('typed').focus();
  sigChanged();
});
function sigReady() { return S.mode === 'draw' ? !!drawnSig() : typedCheck(); }
function sigChanged() { updateButtons(); }

/* ------------------------------------------------------------------ opening a PDF */
const drop = $('drop'), fileIn = $('file');
drop.onclick = () => fileIn.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
fileIn.onchange = () => { if (fileIn.files[0]) openFile(fileIn.files[0]); fileIn.value = ''; };
['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f && !drop.contains(e.target)) openFile(f); });

async function openFile(f) {
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return status('That is not a PDF.', true);
  await openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
}
async function openBytes(bytes, name) {
  status('Opening ' + name + ' ...');
  try {
    S.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (e) {
    return status(/password/i.test(String(e && e.name || e)) ? 'This PDF is password-protected. Remove the password first.' : 'Could not read this PDF: ' + (e.message || e), true);
  }
  S.bytes = bytes; S.name = name; S.items = []; S.sel = null; S.pages = [];
  $('fname').textContent = name + ' · ' + S.pdf.numPages + ' page' + (S.pdf.numPages > 1 ? 's' : '');
  $('empty').hidden = true; $('sheets').innerHTML = '';
  for (let i = 1; i <= S.pdf.numPages; i++) {
    const page = await S.pdf.getPage(i), vp = page.getViewport({ scale: 1 });
    const el = document.createElement('div'); el.className = 'sheet';
    el.innerHTML = '<div class="cap">Page ' + i + ' of ' + S.pdf.numPages + '</div><canvas></canvas>';
    $('sheets').appendChild(el);
    const P = { n: i - 1, page, vp, el, canvas: el.querySelector('canvas'), drawnAt: 0 };
    el.addEventListener('pointerdown', (e) => sheetDown(e, P));
    S.pages.push(P);
  }
  await layout(true);
  status('Make your signature, then click Signature and click the page.');
  updateButtons();
}

/** Size every sheet to the view and (re)draw the pages that need it. */
async function layout(force) {
  const avail = Math.max(260, $('view').clientWidth - 40);
  for (const P of S.pages) {
    P.scale = Math.min(avail, 920) / P.vp.width;
    P.el.style.width = P.vp.width * P.scale + 'px'; P.el.style.height = P.vp.height * P.scale + 'px';
  }
  S.items.forEach(renderItem);
  for (const P of S.pages) {
    if (!force && P.drawnAt && Math.abs(P.drawnAt - P.scale) / P.drawnAt < 0.2) continue;
    const d = window.devicePixelRatio || 1, vp = P.page.getViewport({ scale: P.scale * d });
    P.canvas.width = Math.round(vp.width); P.canvas.height = Math.round(vp.height);
    await P.page.render({ canvasContext: P.canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;   // 'print': no rAF stall in hidden tabs
    P.drawnAt = P.scale;
  }
}
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.pages.length) layout(false); if (S.mode === 'draw') padSize(); }, 150); });

/* ------------------------------------------------------------------ items on the page */
const measure = document.createElement('canvas').getContext('2d');
function textWidth(t, fs) { measure.font = fs + 'px Helvetica, Arial, sans-serif'; return measure.measureText(t).width; }
function dateText() {
  const d = new Date(), M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p = (n) => String(n).padStart(2, '0');
  return { long: M[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(), us: p(d.getMonth() + 1) + '/' + p(d.getDate()) + '/' + d.getFullYear(),
           iso: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()), eu: p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() }[$('datefmt').value];
}
function arm(kind) {
  S.armed = S.armed === kind ? null : kind;
  ['sig', 'date', 'text'].forEach((k) => $('add' + k).classList.toggle('armed', S.armed === k));
  S.pages.forEach((P) => P.el.classList.toggle('placing', !!S.armed));
  $('textrow').hidden = S.armed !== 'text';
  if (S.armed === 'text') $('textval').focus();
  if (S.armed) status('Click the page where it goes.');
}
$('addsig').onclick = () => arm('sig'); $('adddate').onclick = () => arm('date'); $('addtext').onclick = () => arm('text');

function newItem(kind, P, cx, cy) {
  let it;
  if (kind === 'sig' && S.mode === 'draw') {
    const g = drawnSig(); if (!g) return status('Draw your signature first.', true);
    let h = 34, w = h * g.aspect; if (w > 210) { w = 210; h = w / g.aspect; }
    it = { kind: 'draw', strokes: g.strokes, lw: g.lw, w, h };
  } else {
    let text, fs = 11;
    if (kind === 'sig') { if (!typedCheck()) return status('Type your signature first.', true); text = typedText(); fs = 14; }
    else if (kind === 'date') text = dateText();
    else { text = $('textval').value.trim(); if (!text) { $('textval').focus(); return status('Type the text first.', true); } }
    it = { kind: kind === 'sig' ? 'typed' : kind, text, fs, w: textWidth(text, fs) + 2, h: fs * 1.1 };
  }
  it.id = S.nextId++; it.page = P.n;
  it.x = Math.max(0, Math.min(P.vp.width - it.w, cx - it.w / 2)); it.y = Math.max(0, Math.min(P.vp.height - it.h, cy - it.h / 2));
  S.items.push(it); renderItem(it); select(it); updateButtons();
  status('Placed. Drag it into position, or pull the gold corner to resize.');
}

function renderItem(it) {
  const P = S.pages[it.page], s = P.scale;
  let el = document.getElementById('it' + it.id);
  if (!el) {
    el = document.createElement('div'); el.className = 'item'; el.id = 'it' + it.id;
    el.innerHTML = '<span class="del" title="Remove">&times;</span><span class="rs" title="Resize">&#8600;</span>';
    el.addEventListener('pointerdown', (e) => itemDown(e, it));
    el.querySelector('.del').addEventListener('pointerdown', (e) => { e.stopPropagation(); removeItem(it); });
    el.querySelector('.rs').addEventListener('pointerdown', (e) => itemDown(e, it, true));
    P.el.appendChild(el);
  }
  Object.assign(el.style, { left: it.x * s + 'px', top: it.y * s + 'px', width: it.w * s + 'px', height: it.h * s + 'px' });
  el.querySelectorAll('svg,.txt').forEach((n) => n.remove());
  if (it.kind === 'draw') {
    const W = it.w * s, H = it.h * s, ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', strokesPath(it, (p) => [p.x * W, p.y * H]));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', $('ink').value); path.setAttribute('stroke-width', it.lw * H);
    path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path); el.insertBefore(svg, el.firstChild);
  } else {
    const t = document.createElement('div'); t.className = 'txt'; t.textContent = it.text;
    Object.assign(t.style, { fontSize: it.fs * s + 'px', top: it.fs * 0.05 * s + 'px', color: it.kind === 'typed' ? $('ink').value : '#111' });
    el.insertBefore(t, el.firstChild);
  }
}
/** SVG path data for a drawn signature; map(p) -> [x, y] in the target space. Same curve as the pad. */
function strokesPath(it, map) {
  const f = (n) => Math.round(n * 100) / 100; let d = '';
  for (const s of it.strokes) {
    const q = s.map(map); if (!q.length) continue;
    d += 'M' + f(q[0][0]) + ' ' + f(q[0][1]);
    if (q.length === 1) { d += 'L' + f(q[0][0] + 0.01) + ' ' + f(q[0][1]); continue; }
    for (let i = 1; i < q.length - 1; i++) { const m = [(q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2]; d += 'Q' + f(q[i][0]) + ' ' + f(q[i][1]) + ' ' + f(m[0]) + ' ' + f(m[1]); }
    const l = q[q.length - 1]; d += 'L' + f(l[0]) + ' ' + f(l[1]);
  }
  return d;
}
function select(it) { S.sel = it; document.querySelectorAll('.item').forEach((e) => e.classList.toggle('sel', it && e.id === 'it' + it.id)); }
function removeItem(it) { S.items = S.items.filter((x) => x !== it); const e = document.getElementById('it' + it.id); if (e) e.remove(); if (S.sel === it) S.sel = null; updateButtons(); }

function sheetDown(e, P) {
  if (e.target.closest('.item')) return;
  if (!S.armed) { select(null); return; }
  const r = P.el.getBoundingClientRect(), kind = S.armed;
  newItem(kind, P, (e.clientX - r.left) / P.scale, (e.clientY - r.top) / P.scale);
  arm(null);
}
function itemDown(e, it, resize) {
  e.preventDefault(); e.stopPropagation(); select(it);
  const P = S.pages[it.page], el = document.getElementById('it' + it.id), sx = e.clientX, sy = e.clientY, o = { x: it.x, y: it.y, w: it.w, h: it.h, fs: it.fs };
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const move = (ev) => {
    const dx = (ev.clientX - sx) / P.scale, dy = (ev.clientY - sy) / P.scale;
    if (resize) {   // keep the proportions: a signature must not be stretched
      const k = Math.min(Math.max(0.25, Math.min(6, (o.w + dx) / o.w)), (P.vp.width - it.x) / o.w, (P.vp.height - it.y) / o.h);
      it.w = o.w * k; it.h = o.h * k; if (it.fs) it.fs = o.fs * k;
    } else {
      it.x = Math.max(0, Math.min(P.vp.width - it.w, o.x + dx)); it.y = Math.max(0, Math.min(P.vp.height - it.h, o.y + dy));
    }
    renderItem(it);
  };
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); removeItem(S.sel); }
  if (e.key === 'Escape') { arm(null); select(null); }
});

/* ------------------------------------------------------------------ the signed copy */
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return PDFLib.rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); }
async function buildSigned() {
  const { PDFDocument, StandardFonts, degrees, LineCapStyle } = PDFLib;
  const doc = await PDFDocument.load(S.bytes, { ignoreEncryption: true, updateMetadata: false });
  const notes = [];
  if ($('flatten').checked) {
    try { const form = doc.getForm(); if (form.getFields().length) { form.flatten(); notes.push('form fields flattened'); } }
    catch (e) { notes.push('form fields could not be flattened (' + (e.message || e) + ')'); }
  }
  const font = await doc.embedFont(StandardFonts.Helvetica), ink = hexRgb($('ink').value), black = PDFLib.rgb(0.07, 0.07, 0.07);
  for (const it of S.items) {
    const P = S.pages[it.page], page = doc.getPage(it.page), pt = (x, y) => P.vp.convertToPdfPoint(x, y);
    if (it.kind === 'draw') {
      // every point straight into PDF user space; drawSvgPath at (0,0) maps svg (X, -Y) onto (X, Y)
      const d = strokesPath(it, (p) => { const q = pt(it.x + p.x * it.w, it.y + p.y * it.h); return [q[0], -q[1]]; });
      page.drawSvgPath(d, { x: 0, y: 0, borderColor: ink, borderWidth: it.lw * it.h, borderLineCap: LineCapStyle.Round });
    } else {
      const a = pt(it.x, it.y + it.fs * 0.9), b = pt(it.x + 1, it.y + it.fs * 0.9);   // baseline start and direction
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      try { page.drawText(it.text, { x: a[0], y: a[1], size: it.fs, font, color: it.kind === 'typed' ? ink : black, rotate: degrees(ang) }); }
      catch (e) { throw new Error('"' + it.text + '" has a character the standard PDF font cannot write. Use Latin letters, or draw the signature instead.'); }
    }
  }
  doc.setModificationDate(new Date());
  return { bytes: await doc.save({ useObjectStreams: false }), notes };
}
$('save').onclick = async () => {
  if (!S.items.length) return status('Place your signature on the page first.', true);
  $('save').disabled = true; status('Writing the signed PDF ...');
  try {
    const { bytes, notes } = await buildSigned();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = S.name.replace(/\.pdf$/i, '') + '-signed.pdf'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    status('Saved ' + a.download + (notes.length ? ' (' + notes.join('; ') + ')' : '') + '. Open it to check before you send it.');
    window.__lastSigned = bytes;   // for the tests
  } catch (e) { status(e.message || String(e), true); }
  $('save').disabled = false;
};

/* ------------------------------------------------------------------ misc */
function status(t, bad) { const s = $('status'); s.textContent = t; s.style.color = bad ? 'var(--bad)' : ''; return null; }
function updateButtons() {
  const open = !!S.pages.length;
  $('addsig').disabled = !open || !sigReady(); $('adddate').disabled = !open; $('addtext').disabled = !open;
  $('save').disabled = !open || !S.items.length;
}
$('datefmt').onchange = () => S.items.filter((i) => i.kind === 'date').forEach((i) => { i.text = dateText(); i.w = textWidth(i.text, i.fs) + 2; renderItem(i); });

/** A sample agreement, made here (no file is fetched), so the page can be tried without a document of one's own. */
async function demo() {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create(), p = doc.addPage([612, 792]);
  const f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold), g = rgb(0.1, 0.1, 0.1);
  p.drawText('SAMPLE DOCUMENT - NOT A REAL AGREEMENT', { x: 72, y: 730, size: 9, font: f, color: rgb(0.6, 0.15, 0.1) });
  p.drawText('Assignment of Invention', { x: 72, y: 700, size: 18, font: fb, color: g });
  const body = ['For good and valuable consideration, the receipt of which is acknowledged, the undersigned',
    'Assignor assigns to Example Widgets, LLC (the "Assignee") all right, title and interest in the',
    'invention entitled "Self-Righting Coffee Mug," the application for it, and any patent granted on it.',
    '', 'The Assignor agrees to sign any further papers the Assignee reasonably needs to obtain and',
    'enforce patent rights in the invention, in the United States and elsewhere.'];
  body.forEach((l, i) => p.drawText(l, { x: 72, y: 660 - i * 17, size: 11, font: f, color: g }));
  const line = (x, y, w, label) => { p.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.8, color: g }); p.drawText(label, { x, y: y - 13, size: 9, font: f, color: rgb(0.35, 0.35, 0.35) }); };
  p.drawText('ASSIGNOR', { x: 72, y: 520, size: 10, font: fb, color: g });
  line(72, 470, 260, 'Signature'); line(372, 470, 168, 'Date');
  line(72, 420, 260, 'Printed name');
  await openBytes(await doc.save(), 'sample-assignment.pdf');
}
$('demo').onclick = demo;
if (/[?&]demo\b/.test(location.search)) demo();
/** ?shot: the sample with a signature and date already placed (the screenshot on the Patent Tools card). */
if (/[?&]shot\b/.test(location.search)) (async () => {
  await demo(); padSize(); pad.strokes = [];
  const r = padc.getBoundingClientRect(), k = r.width / 300, s = [];
  for (let t = 0; t <= 1.0001; t += 0.004) {   // a loose cursive scribble: loops riding a gently falling line
    const x = 24 + t * 250, y = 92 - 26 * Math.sin(t * Math.PI * 9) * Math.exp(-t * 1.2) - 18 * t + 10 * Math.cos(t * Math.PI * 18) * t;
    s.push({ x: x * k, y });
  }
  pad.strokes.push(s, [{ x: 40 * k, y: 40 }, { x: 46 * k, y: 70 }, { x: 52 * k, y: 104 }], [{ x: 150 * k, y: 108 }, { x: 210 * k, y: 101 }, { x: 285 * k, y: 92 }]);
  padDraw(); sigChanged();
  const P = S.pages[0]; newItem('sig', P, 200, 792 - 470 - 16); newItem('date', P, 430, 792 - 470 - 8); select(null);
})();
padSize(); updateButtons();
