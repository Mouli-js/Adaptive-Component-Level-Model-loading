// Builds the final MCA report (.docx) from the content modules in this folder.
// Usage: node build.js [pages.json]   (pages.json = page numbers from a previous render, for the static contents lists)
// Code excerpts are read VERBATIM from the repository at build time (file + line range shown in each caption).
const fs = require('fs'), path = require('path');
const d = require('docx');
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
        ShadingType, Header, PageNumber, NumberFormat, LevelFormat, PageBreak, TabStopType, VerticalAlign,
        PageBorderDisplay, PageBorderOffsetFrom, HeadingLevel, SectionType } = d;

const REPO = process.env.REPO || path.resolve(__dirname, '../../..');
const FR = path.resolve(__dirname, '..');
const OUT = process.env.OUT || path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx');
const pages = fs.existsSync(process.argv[2] || '') ? JSON.parse(fs.readFileSync(process.argv[2])) : {};

const FONT = 'Times New Roman', MONO = 'Courier New';
const TEXT_W = 9026 - 360;  // A4 text width in DXA with margins 1.25in left / 1in right ≈ 8666
const PX_W = 570, PX_H = 760;   // max image box in px (96 dpi)

// ---------- content ----------
const C = require('./content');
const blocks = [...C.front(), ...C.ch1(), ...C.ch2(), ...C.ch3(), ...C.ch3x(), ...C.ch4(), ...C.refs(), ...C.app()];

// ---------- numbering pre-pass ----------
let nf = 0, nt = 0; const label = {}; const lists = { fig: [], tab: [], toc: [] };
for (const b of blocks) {
  if (b.t === 'fig' || b.t === 'code') { b.n = ++nf; if (b.id) label['fig:' + b.id] = nf; lists.fig.push(b); }
  if (b.t === 'table') { b.n = ++nt; if (b.id) label['tab:' + b.id] = nt; lists.tab.push(b); }
  if (['h1', 'h2', 'h3', 'fronth'].includes(b.t) && !b.notoc) lists.toc.push(b);
}
const resolve = s => s.replace(/@(fig|tab):([\w-]+)/g, (m, k, id) => {
  const n = label[k + ':' + id]; if (!n) throw new Error('unresolved ref ' + m); return (k === 'fig' ? 'Figure ' : 'Table ') + n; });

// ---------- inline markup: **bold**, *italic*, `code` ----------
function runs(text, base = {}) {
  text = resolve(text); const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w-])\*[^*\s](?:[^*]*[^*\s])?\*(?![\w]))/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), font: FONT, ...base }));
    const s = m[0];
    if (s.startsWith('**')) out.push(new TextRun({ text: s.slice(2, -2), bold: true, font: FONT, ...base }));
    else if (s.startsWith('`')) out.push(new TextRun({ text: s.slice(1, -1), font: MONO, ...base, size: Math.round((base.size || 24) * 0.88) }));
    else out.push(new TextRun({ text: s.slice(1, -1), italics: true, font: FONT, ...base }));
    last = m.index + s.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), font: FONT, ...base }));
  return out;
}
const P = (text, o = {}) => new Paragraph({ children: runs(text, o.run), alignment: o.align ?? AlignmentType.JUSTIFIED,
  spacing: { line: o.line ?? 360, after: o.after ?? 120, before: o.before ?? 0 }, keepNext: o.keepNext, indent: o.indent, pageBreakBefore: o.pageBreakBefore,
  heading: o.heading, outlineLevel: o.outlineLevel });

// ---------- syntax highlighting (print-safe: dark colours + bold/italic) ----------
const KW = { js: /\b(const|let|var|function|async|await|return|if|else|for|of|in|new|class|export|import|from|throw|try|catch|static|this|null|true|false|continue|break)\b/,
             py: /\b(def|class|return|for|in|if|else|import|from|None|True|False|with|as|self|super)\b/, json: /$^/ };
function highlight(line, lang) {
  const out = []; const kw = KW[lang] || KW.js;
  const tok = /(\/\/.*$|#.*$|"""[^]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  let last = 0, m;
  const push = (t, o = {}) => out.push(new TextRun({ text: t, font: MONO, size: 16, ...o }));
  while ((m = tok.exec(line))) {
    if (m.index > last) push(line.slice(last, m.index));
    const s = m[0];
    if ((lang !== 'py' && s.startsWith('//')) || (lang === 'py' && s.startsWith('#'))) push(s, { color: '5F6368', italics: true });
    else if (s.startsWith('#') && lang !== 'py') push(s);
    else if (/^["'`]/.test(s)) push(s, { color: '0B6623' });
    else if (/^\d/.test(s)) push(s, { color: '8B4513' });
    else if (kw.test(s) && s.match(kw)[0] === s) push(s, { color: '00008B', bold: true });
    else push(s);
    last = m.index + s.length;
  }
  if (last < line.length) push(line.slice(last));
  if (!out.length) push(' ');
  return out;
}
function readLines(file, from, to) {
  const all = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
  if (to > all.length) throw new Error(`${file} has ${all.length} lines, asked ${to}`);
  return all.slice(from - 1, to).map((l, i) => ({ n: from + i, l }));
}

// ---------- renderers ----------
// Captions: "Figure <SEQ field>. <first sentence>" (what Word's List of Figures shows); any further sentences of the
// caption follow in a smaller note paragraph, so no caption text is lost.
function splitCap(c) { const m = c.match(/^(.+?[a-z0-9)`’”])\. (?=[A-Z`(])/s); return m ? [m[1] + '.', c.slice(m[0].length)] : [c, '']; }
const seqRuns = (kind, n, size) => [new TextRun({ text: `${kind} `, bold: true, font: FONT, size }), new TextRun({ text: `§SEQ:${kind}:${n}§`, bold: true, font: FONT, size }),
                                    new TextRun({ text: '. ', bold: true, font: FONT, size })];
const capNote = (rest, after) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after, line: 252 }, children: runs(rest, { size: 18, italics: true }) });
const capFig = b => { const [head, rest] = splitCap(b.caption); b.head = head;
  const cap = new Paragraph({ style: 'Caption', alignment: AlignmentType.CENTER, keepNext: !!rest, spacing: { before: 60, after: rest ? 40 : 240, line: 276 },
    children: [...seqRuns('Figure', b.n, 21), ...runs(head, { size: 21 })] });
  return rest ? [cap, capNote(rest, 240)] : [cap]; };
function imgSize(file) {
  const buf = fs.readFileSync(file); const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); return { buf, w, h };
}
function figure(b) {
  const f = path.join(FR, b.src.startsWith('/') ? b.src.slice(1) : b.src); const { buf, w, h } = imgSize(fs.existsSync(f) ? f : path.join(REPO, b.src));
  const maxW = PX_W * (b.w ?? 1); let W = maxW, H = h * maxW / w; const maxH = PX_H * (b.maxH ?? 1);
  if (H > maxH) { H = maxH; W = w * maxH / h; }
  return [new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 0 },
    children: [new ImageRun({ type: 'png', data: buf, transformation: { width: Math.round(W), height: Math.round(H) },
      altText: { title: `Figure ${b.n}`, description: b.caption, name: `fig${b.n}` } })] }), ...capFig(b)];
}
function codeBlock(b) {
  const parts = b.parts ?? [{ from: b.from, to: b.to }]; const lines = [];
  parts.forEach((pt, k) => { if (k > 0) lines.push({ n: null, l: '…' }); lines.push(...readLines(b.file, pt.from, pt.to)); });
  const paras = lines.map(({ n, l }) => new Paragraph({ spacing: { line: 240, after: 0 }, keepNext: true, keepLines: true,
    children: [new TextRun({ text: (n == null ? '' : String(n)).padStart(4, ' ') + '  ', font: MONO, size: 14, color: '80868B' }), ...highlight(l.replace(/\t/g, '  '), b.lang)] }));
  const t = new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [TEXT_W], rows: [new TableRow({ cantSplit: lines.length < 40,
    children: [new TableCell({ width: { size: TEXT_W, type: WidthType.DXA }, shading: { fill: 'F4F4F2', type: ShadingType.CLEAR, color: 'auto' },
      margins: { top: 100, bottom: 100, left: 140, right: 140 },
      borders: { top: { style: BorderStyle.SINGLE, size: 4, color: '9AA0A6' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: '9AA0A6' },
                 left: { style: BorderStyle.SINGLE, size: 4, color: '9AA0A6' }, right: { style: BorderStyle.SINGLE, size: 4, color: '9AA0A6' } },
      children: paras })] })] });
  const range = (b.parts ?? [{ from: b.from, to: b.to }]).map(p => `${p.from}–${p.to}`).join(', ');
  const caps = capFig({ ...b, caption: `${b.caption} Source: \`${b.file}\`, lines ${range}.` }); b.head = splitCap(b.caption)[0]; return [t, ...caps];
}
function table(b) {
  const tot = b.widths.reduce((a, x) => a + x, 0); const cw = b.widths.map(x => Math.floor(TEXT_W * x / tot)); cw[cw.length - 1] += TEXT_W - cw.reduce((a, x) => a + x, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: '6B6B6B' };
  const cell = (txt, i, head) => new TableCell({ width: { size: cw[i], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    shading: head ? { fill: 'E7E6E6', type: ShadingType.CLEAR, color: 'auto' } : undefined, margins: { top: b.size ? 30 : 50, bottom: b.size ? 30 : 50, left: 90, right: 90 },
    borders: { top: border, bottom: border, left: border, right: border },
    children: String(txt).split('\n').map(line => new Paragraph({ spacing: { line: 252, after: 0 }, alignment: (b.align?.[i] === 'r') ? AlignmentType.RIGHT : (b.align?.[i] === 'c' ? AlignmentType.CENTER : AlignmentType.LEFT),
      children: runs(line, { size: b.size ?? 18, bold: head || undefined }) })) });
  const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: b.head.map((h, i) => cell(h, i, true)) }),
                ...b.rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false)) }))];
  const [head, rest] = splitCap(b.caption); b.head = head;
  const cap = new Paragraph({ style: 'Caption', alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 200, after: rest ? 20 : 80, line: 276 },
    children: [...seqRuns('Table', b.n, 21), ...runs(head, { size: 21 })] });
  const out = [cap, ...(rest ? [new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { after: 80, line: 252 }, children: runs(rest, { size: 18, italics: true }) })] : []), new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: cw, rows })];
  out.push(new Paragraph({ spacing: { before: 60, after: 160, line: 252 }, alignment: AlignmentType.JUSTIFIED, children: b.note ? runs(b.note, { size: 18, italics: true }) : [] }));
  return out;
}
const marker = m => [new Paragraph({ children: [new TextRun({ text: `§${m}§`, font: FONT, size: 22 })] })];
let olRef = 0;
function render(b) {
  switch (b.t) {
    case 'pb': return [new Paragraph({ children: [new PageBreak()] })];
    case 'p': return [P(b.text, b)];
    case 'raw': return b.make(d, { FONT, runs, P, TEXT_W });
    case 'fronth': return [new Paragraph({ heading: b.notoc ? undefined : HeadingLevel.HEADING_1, style: b.notoc ? 'TOCHeading' : undefined, alignment: AlignmentType.CENTER, pageBreakBefore: !b.noBreak, spacing: { after: 300 },
      children: [new TextRun({ text: b.text, bold: true, font: FONT, size: 30 })] })];
    case 'h1': return [new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.LEFT, pageBreakBefore: true, spacing: { after: 360 },
      children: [new TextRun({ text: b.num ? `${b.num}    ${b.text}` : b.text, bold: true, font: FONT, size: 32 })] })];
    case 'h2': return [new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 280, after: 140 },
      children: [new TextRun({ text: `${b.num}  ${b.text}`, bold: true, font: FONT, size: 28 })] })];
    case 'h3': return [new Paragraph({ heading: HeadingLevel.HEADING_3, keepNext: true, spacing: { before: 220, after: 100 },
      children: [new TextRun({ text: `${b.num}  ${b.text}`, bold: true, font: FONT, size: 24 })] })];
    case 'ul': return b.items.map(it => new Paragraph({ numbering: { reference: 'bul', level: it.startsWith('  ') ? 1 : 0 }, alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 336, after: 60 }, children: runs(it.trim()) }));
    case 'ol': { const ref = 'num' + (olRef++); numberingConfigs.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] });
      return b.items.map(it => new Paragraph({ numbering: { reference: ref, level: 0 }, alignment: AlignmentType.JUSTIFIED, spacing: { line: 336, after: 60 }, children: runs(it) })); }
    case 'fig': return figure(b);
    case 'code': return codeBlock(b);
    case 'table': return table(b);
    case 'toc': return marker('TOC');
    case 'lof': return marker('LOF');
    case 'lot': return marker('LOT');
    default: throw new Error('unknown block ' + b.t);
  }
}
const numberingConfigs = [{ reference: 'bul', levels: [
  { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 300 } } } },
  { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 300 } } } }] }];

// ---------- sections ----------
const cut = (k) => blocks.findIndex(b => b.section === k);
const iFront = cut('front'), iBody = cut('body');
const toKids = arr => arr.flatMap(render);
const titleKids = toKids(blocks.slice(0, iFront)), frontKids = toKids(blocks.slice(iFront, iBody)), bodyKids = toKids(blocks.slice(iBody));
const border = { style: BorderStyle.SINGLE, size: 12, color: '000000', space: 24 };
const pageProps = (fmt, start) => ({ page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1300, left: 1800, right: 1440, header: 720 },
  borders: { pageBorderTop: border, pageBorderBottom: border, pageBorderLeft: border, pageBorderRight: border,
             pageBorders: { display: PageBorderDisplay.ALL_PAGES, offsetFrom: PageBorderOffsetFrom.PAGE } },
  pageNumbers: fmt ? { start, formatType: fmt } : undefined } });
// Page frame: a full-page transparent PNG with a 1.5 pt rectangle 24 pt from the page edge, anchored behind the text in
// every header. It sits exactly on top of the section's page border (pgBorders), so Word and LibreOffice show one line,
// and renderers that ignore Word page borders still show the frame.
const FRAME = fs.readFileSync(path.join(FR, 'figures', 'page_frame.png'));
const frameRun = () => new ImageRun({ type: 'png', data: FRAME, transformation: { width: 794, height: 1123 },
  altText: { title: 'Page border', description: 'Decorative page border', name: 'page-frame' },
  floating: { horizontalPosition: { relative: d.HorizontalPositionRelativeFrom.PAGE, offset: 0 }, verticalPosition: { relative: d.VerticalPositionRelativeFrom.PAGE, offset: 0 },
              behindDocument: true, allowOverlap: true, lockAnchor: true, wrap: { type: d.TextWrappingType.NONE } } });
// Page numbers: PAGE fields with an explicit format switch (roman / Arabic) in addition to the section's number format.
const numHeader = fmt => ({ default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
  children: [frameRun(), new TextRun({ text: `§PAGE:${fmt}§`, font: FONT, size: 22 })] })] }) });
const emptyHeader = () => ({ default: new Header({ children: [new Paragraph({ children: [frameRun()] })] }) });

const doc = new Document({
  creator: '[STUDENT NAME]', title: 'Adaptive Component-Level Model Loading for Resource-Constrained Browser-Based AI Inference', description: 'MCA mini project report (draft)',
  styles: { default: { document: { run: { font: FONT, size: 24 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 32, bold: true }, paragraph: { outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 28, bold: true }, paragraph: { outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 24, bold: true }, paragraph: { outlineLevel: 2 } },
      { id: 'Caption', name: 'caption', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 21 } },
      { id: 'TOCHeading', name: 'TOC Heading', basedOn: 'Normal', next: 'Normal', run: { font: FONT, size: 30, bold: true } },
      ...[1, 2, 3].map(k => ({ id: 'TOC' + k, name: 'toc ' + k, basedOn: 'Normal', next: 'Normal', run: { font: FONT, size: 22, bold: k === 1 },
        paragraph: { indent: { left: (k - 1) * 400 }, spacing: { before: k === 1 ? 100 : 0, after: k === 1 ? 40 : 20, line: 276 },
                     tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W - 10, leader: 'dot' }] } })),
      { id: 'TableofFigures', name: 'table of figures', basedOn: 'Normal', next: 'Normal', run: { font: FONT, size: 22 },
        paragraph: { indent: { left: 1100, hanging: 1100 }, spacing: { after: 40, line: 276 }, tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W - 10, leader: 'dot' }] } }] },
  numbering: { config: numberingConfigs },
  sections: [
    { properties: pageProps(null), headers: emptyHeader(), children: titleKids },
    { properties: { type: SectionType.NEXT_PAGE, ...pageProps(NumberFormat.LOWER_ROMAN, 1) }, headers: numHeader('roman'), children: frontKids },
    { properties: { type: SectionType.NEXT_PAGE, ...pageProps(NumberFormat.DECIMAL, 1) }, headers: numHeader('Arabic'), children: bodyKids },
  ],
});
const plain = t => resolve(t).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(?<![\w-])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w])/g, '$1');
fs.writeFileSync(path.join(__dirname, 'lists.json'), JSON.stringify({
  toc: lists.toc.map(x => { const text = x.t === 'h1' ? (x.num ? `${x.num}    ${x.text}` : x.text) : x.t === 'fronth' ? x.text : `${x.num}  ${x.text}`;
    return { key: 'h:' + (x.num || x.text), find: text, text, level: x.t === 'h2' ? 2 : x.t === 'h3' ? 3 : 1, body: x.t !== 'fronth' }; }),
  fig: lists.fig.map(x => ({ key: 'f:' + x.n, find: `Figure ${x.n}.`, text: `Figure ${x.n}. ${plain(x.head)}` })),
  tab: lists.tab.map(x => ({ key: 't:' + x.n, find: `Table ${x.n}.`, text: `Table ${x.n}. ${plain(x.head)}` })) }, null, 1));
Packer.toBuffer(doc).then(b => { fs.writeFileSync(OUT, b); console.log('wrote', OUT, 'figures', nf, 'tables', nt); });
