// Report content. Every number is taken from the cited repository file; see EVIDENCE_MAP.md.
const h1 = (num, text, x = {}) => ({ t: 'h1', num, text, ...x });
const h2 = (num, text) => ({ t: 'h2', num, text });
const h3 = (num, text) => ({ t: 'h3', num, text });
const p = (text, x = {}) => ({ t: 'p', text, ...x });
const ul = (...items) => ({ t: 'ul', items });
const ol = (...items) => ({ t: 'ol', items });
const fig = (id, src, caption, x = {}) => ({ t: 'fig', id, src, caption, ...x });
const code = (id, file, from, to, lang, caption, x = {}) => ({ t: 'code', id, file, from, to, lang, caption, ...x });
const tab = (id, caption, head, rows, widths, x = {}) => ({ t: 'table', id, caption, head, rows, widths, ...x });
const pb = () => ({ t: 'pb' });
module.exports.H = { h1, h2, h3, p, ul, ol, fig, code, tab, pb };


// Bonafide signature blocks: a borderless two-column table (guide | head of department), with a separate date/seal row.
function sigTable(d, FONT) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, AlignmentType, BorderStyle } = d;
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, nb = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const W = 8666, col = [4333, 4333];
  const line = (t, o = {}) => new Paragraph({ alignment: o.align, spacing: { after: 40, before: o.before ?? 0, line: 276 }, children: [new TextRun({ text: t, font: FONT, size: 24, bold: o.bold })] });
  const block = (align, rows) => new TableCell({ width: { size: col[0], type: WidthType.DXA }, borders: nb, margins: { left: 60, right: 60 }, children: rows.map((r, i) => line(r, { align, bold: i === 1, before: i === 0 ? 0 : 0 })) });
  const L = AlignmentType.LEFT, R = AlignmentType.RIGHT;
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: col, borders: nb, rows: [
    new TableRow({ children: [block(L, ['[SIGNATURE]', '[GUIDE NAME]', '[DESIGNATION]', 'Directorate of Online Education', 'SRM Institute of Science and Technology']),
                              block(R, ['[SIGNATURE]', '[NAME]', '[HEAD / DIRECTOR — DESIGNATION]', 'Directorate of Online Education', 'SRM Institute of Science and Technology'])] }),
    new TableRow({ children: [new TableCell({ width: { size: col[0], type: WidthType.DXA }, borders: nb, children: [line('Date: [DATE]', { align: L, before: 900 })] }),
                              new TableCell({ width: { size: col[1], type: WidthType.DXA }, borders: nb, children: [line('[SEAL]', { align: R, before: 900 })] })] }),
  ] });
}

const TITLE = 'Adaptive Component-Level Model Loading for Resource-Constrained Browser-Based AI Inference';

module.exports.front = () => [
  { t: 'raw', make: (d, { FONT }) => {
    const { Paragraph, TextRun, AlignmentType } = d;
    const c = (text, size, o = {}) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: o.before ?? 0, after: o.after ?? 80 },
      children: [new TextRun({ text, font: FONT, size, bold: o.bold, italics: o.italics, color: o.color })] });
    return [
      c(TITLE.toUpperCase(), 32, { bold: true, before: 600, after: 360 }),
      c('MINI PROJECT REPORT', 28, { bold: true, after: 480 }),
      c('Submitted by', 24, { italics: true, after: 160 }),
      c('[STUDENT NAME]', 26, { bold: true }), c('[REGISTER NUMBER]', 24, { after: 480 }),
      c('Under the Guidance of', 24, { italics: true, after: 160 }),
      c('[GUIDE NAME]', 26, { bold: true }), c('([DESIGNATION], Directorate of Online Education)', 24, { after: 360 }),
      c('in partial fulfillment for the award of the degree of', 24, { italics: true, after: 160 }),
      c('MASTER OF COMPUTER APPLICATIONS', 28, { bold: true, after: 600 }),
      c('[SRM ONLINE LOGO]', 22, { color: '808080', after: 600 }),
      c('DIRECTORATE OF ONLINE EDUCATION', 26, { bold: true }),
      c('SRM INSTITUTE OF SCIENCE AND TECHNOLOGY', 26, { bold: true }),
      c('KATTANKULATHUR – 603 203', 24, { bold: true, after: 480 }),
      c('[MONTH YEAR]', 26, { bold: true }),
    ]; } },

  { t: 'raw', section: 'front', make: (d, { FONT }) => {
    const { Paragraph, TextRun, AlignmentType } = d;
    const c = (text, size, o = {}) => new Paragraph({ alignment: o.align ?? AlignmentType.CENTER, spacing: { before: o.before ?? 0, after: o.after ?? 80, line: o.line ?? 276 },
      children: [new TextRun({ text, font: FONT, size, bold: o.bold })] });
    return [
      c('DIRECTORATE OF ONLINE EDUCATION', 26, { bold: true, before: 200 }), c('SRM INSTITUTE OF SCIENCE AND TECHNOLOGY', 26, { bold: true }),
      c('KATTANKULATHUR – 603 203', 24, { bold: true, after: 600 }),
      c('BONAFIDE CERTIFICATE', 30, { bold: true, after: 600 }),
      new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { line: 480, after: 1400 }, children: [new TextRun({ font: FONT, size: 24,
        text: `This Mini Project Work Report titled “${TITLE}” is the bonafide work of [STUDENT NAME] [REGISTER NUMBER], who carried out the Mini Project Work under my supervision. Certified further, that to the best of my knowledge the work reported herein does not form any other internship report or dissertation based on which a degree or award was conferred on an earlier occasion on this or any other candidate.` })] }),
      sigTable(d, FONT),
    ]; } },

  { t: 'fronth', text: 'Abstract', inToc: true },
  p('Transformer language models are increasingly run inside the web browser so that text never leaves the user’s device. A browser tab, however, is a constrained environment: in this project a 255.5 MiB DistilBERT sentiment model needed a 656 MiB WebAssembly heap, and that heap was not returned when the model was released. The objective of this project was to design, build and evaluate a library that loads such a model as separate components and decides, for each device, which components to keep in memory, at which numeric precision, and when to unload them, while keeping accuracy above a stated floor.'),
  p('The fine-tuned DistilBERT-SST2 model was split into four ONNX components (embeddings, two pairs of encoder layers, and the last two layers with the classifier), exported in fp32 and dynamic int8, and given two early-exit classifiers. In the browser each component runs in its own Web Worker on ONNX Runtime Web (WebAssembly); in a cloud measurement, terminating the Workers brought the page’s measured memory back to its starting level, whereas releasing the model sessions freed none of it. Components are cached in IndexedDB under their SHA-256 hash and verified on every read. A deterministic decision engine reads the browser’s resource signals or a simulated device profile, rejects plans that would exceed the memory budget or the accuracy floor, and selects the plan with the lowest weighted cost of memory, time and initial load, together with a written explanation. The work is packaged as the npm-style package `adaptive-onnx-loader` with a demonstration page.'),
  p('Pre-registered experiments were run on a cloud machine and, separately, on an Apple Silicon Mac. Loading one component at a time reduced peak memory by 55–57% against the unsplit model (cloud), at the cost of a 50–72% longer time to first inference; in the cloud the cache made revisits 1.16 to 78 times faster depending on link speed; and early exit reduced single-request latency in resident plans by 18.6–20.4% in the cloud and by 21.0–21.2% on the Mac, with an accuracy loss (0.11–0.34 points) that was not statistically significant. Several expectations were not met: pre-starting the next component did not shorten time to first inference, no precision difference was significant on the 872-sentence validation set, and the engine’s time model was optimistic for plans with pre-start or pinned components (28–52% in the cloud, 15–29% on the Mac), which led to a 24–43% regret for one cloud profile. These results and their limitations are reported without adjustment.'),

  { t: 'fronth', text: 'Acknowledgement', inToc: true },
  p('[ACKNOWLEDGEMENT — to be written by the student.]', { align: 0 }),

  { t: 'fronth', text: 'Contents', notoc: true },
  { t: 'toc' },
  { t: 'fronth', text: 'List of Figures', inToc: true },
  { t: 'lof' },
  { t: 'fronth', text: 'List of Tables', inToc: true },
  { t: 'lot' },
  { t: 'fronth', text: 'List of Abbreviations', inToc: true },
  tab(null, 'Abbreviations used in this report.', ['Abbreviation', 'Meaning'], [
    ['API', 'Application Programming Interface'], ['BERT', 'Bidirectional Encoder Representations from Transformers'],
    ['CDP', 'Chrome DevTools Protocol'], ['CI', 'Confidence interval (95%, bootstrap, unless stated)'],
    ['COOP / COEP', 'Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy (HTTP headers)'], ['CPU', 'Central Processing Unit'],
    ['EP', 'Execution provider (ONNX Runtime back-end)'], ['fp32', '32-bit floating point'], ['G', 'Group size: sentences processed per component load'],
    ['IDB', 'IndexedDB (browser object database)'], ['int8', '8-bit integer (here: dynamic int8 quantization)'],
    ['L', 'Initial load time on the first request’s critical path (engine term)'], ['LRU', 'Least recently used'],
    ['M', 'Predicted peak memory (engine term)'], ['M4', 'Latency metric: single-request median, or amortised time per sentence for chunk-major plans'],
    ['MiB / MB', 'Mebibyte (2²⁰ bytes) / megabyte (10⁶ bytes)'], ['mixedC2', 'Precision plan: component C2 in fp32, all others int8'],
    ['ONNX', 'Open Neural Network Exchange'], ['ORT', 'ONNX Runtime'], ['SDLC', 'Software Development Life Cycle'],
    ['SHA-256', 'Secure Hash Algorithm, 256-bit'], ['SST-2', 'Stanford Sentiment Treebank, binary task (GLUE)'],
    ['T', 'Predicted time per sentence (engine term)'], ['TTFI', 'Time to first inference'], ['UA', 'User agent (browser)'],
    ['vCPU', 'Virtual CPU'], ['WASM', 'WebAssembly'], ['τ (tau)', 'Early-exit confidence threshold'],
  ], [1.2, 4]),
];

module.exports.ch1 = () => [
  h1('1', 'Introduction', { section: 'body' }),
  h2('1.1', 'Background and motivation'),
  p('Running a machine-learning model directly in the web browser has practical advantages. The user’s text is processed on the user’s own device, no inference server has to be paid for or maintained, and the application keeps working when the network is slow. Toolkits such as ONNX Runtime Web make this possible by executing a model compiled to WebAssembly inside the page (ONNX Runtime 2026a). The obstacle is resources. A browser tab shares the device’s memory with every other tab and application, the model file must be downloaded before the first prediction, and devices range from high-end laptops to low-memory phones.'),
  p('Two measurements made early in this project show how severe the problem is for a whole model loaded at once. First, the DistilBERT sentiment model used here is a 255.5 MiB file in fp32, but after loading it occupied **656 MiB** of WebAssembly memory; the 64.2 MiB int8 version occupied 180 MiB (Phase 2 report §2; finding F-3). Second, the WebAssembly heap **did not shrink** after the model session was released, either in the cloud browser or on a real Mac (F-4). Within one page, “unloading” a model therefore did not reduce the WebAssembly heap. These observations motivated the approach of this project: treat the model as a set of components that can be loaded, run and discarded individually, and choose automatically how to do so on each device.'),
  h2('1.2', 'Problem statement'),
  p('The project’s research question, as fixed in the Master Plan (§1), was: *can exposing a transformer model’s components as independently managed execution units reduce memory use and transfer overhead in the browser, through adaptive loading and precision selection, while keeping accuracy within an acceptable bound?*'),
  p('Stated as an engineering problem: given a transformer classification model and a device whose memory, processor and network capacity are only partly known to the web page, how can the page load and run the model so that peak memory stays within a budget, accuracy stays above a stated floor, and latency is as low as those constraints allow? The project addresses this for one model and task, the DistilBERT model fine-tuned on SST-2 sentiment classification (Sanh et al. 2019; Socher et al. 2013), executed with ONNX Runtime Web on the WebAssembly back-end.'),
  h2('1.3', 'Objectives'),
  ol('Split the model into components without changing its outputs, and verify the split numerically.',
     'Execute each component in its own Web Worker, so that its memory can be released by terminating the Worker.',
     'Cache components persistently in the browser with integrity verification, so that repeat visits do not download the model again.',
     'Build a deterministic decision engine that selects an execution plan (precision, which components stay loaded, group size, pre-start, early exit) for a device profile and explains its choice.',
     'Offer early exit and mixed precision as options that trade a measured amount of accuracy for speed or size.',
     'Package the work as a reusable JavaScript package with a documented API and a demonstration page.',
     'Evaluate the system with pre-registered hypotheses on two machines (a cloud machine and a real Mac), reporting the two separately, including results that do not support the hypotheses.'),
  h2('1.4', 'Scope'),
  p('**In scope:** one model (DistilBERT-SST2), one task (binary sentiment classification), three precision settings (fp32, int8, and mixed precision with one fp32 component), the ONNX Runtime Web WebAssembly back-end in Chromium-based browsers, a four-component split, IndexedDB caching, simulated device profiles (low, mid, high) and the browser’s own signals, early exit with two exit heads (Master Plan §2). The evaluation used a 2-vCPU cloud machine and an Apple Silicon Mac whose browser reports 8 logical processors (Section 2.10).'),
  p('**Out of scope** (Master Plan §2): generative or causal models, which would need a key–value cache to be handed between components; the WebGPU back-end, whose int8 operator support was inconsistent and would have mixed two back-ends in the comparisons; and training or fine-tuning the base model (only the two small early-exit heads were trained). In addition, the evaluation did not include a real low-memory device or a real network; these are limitations of the results and are listed in Section 4.3.'),
  h2('1.5', 'Organisation of the report'),
  p('The remainder of the report is organised in four parts, following the structure of the departmental sample report:'),
  ul('**Chapter 2, Theoretical background**, introduces the transformer and DistilBERT, ONNX and ONNX Runtime Web, quantization, model splitting, WebAssembly, Web Workers, IndexedDB, decision policies and early exit, and states the project requirements and the development methodology.',
     '**Chapter 3, Practical implementation**, describes the system architecture and each component as built, with source-code excerpts, diagrams and screenshots, followed by the experimental method and the results. Cloud results and Mac results are always reported separately.',
     '**Chapter 4, Conclusion**, summarises the outcome and the main findings, lists the limitations and proposes future work.',
     '**Appendices** contain the findings register, detailed statistics, the experiment configurations, the raw-data index and reproduction instructions.'),
  p('Throughout the report, file paths are written in `monospace`; MiB means 2²⁰ bytes and MB means 10⁶ bytes; a value written as “median [a, b]” is a median with its 95% bootstrap confidence interval; and every measurement is labelled with the configuration it comes from (for example CLOUD-HL-1T or MAC-CHROME-T4).'),
];

Object.assign(module.exports, require('./content_ch2'), require('./content_ch3'), require('./content_ch3x'), require('./content_ch4'));
