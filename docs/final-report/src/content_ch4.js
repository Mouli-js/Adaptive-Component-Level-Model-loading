const fs = require('fs'), path = require('path');
const { h1, h2, h3, p, ul, ol, fig, code, tab } = require('./content').H;
const REPO = process.env.REPO || path.resolve(__dirname, '../../..');
const rd = f => fs.readFileSync(path.join(REPO, f), 'utf8');

// Extract the first markdown table after a heading (verbatim cells) — used so appendix tables are not re-typed.
function mdTable(file, headingStartsWith, { skipCols = [], maxRows = Infinity } = {}) {
  const L = rd(file).split('\n'); let i = L.findIndex(l => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(headingStartsWith));
  if (i < 0) throw new Error(`heading not found: ${file} :: ${headingStartsWith}`);
  while (i < L.length && !L[i].startsWith('|')) i++;
  const rows = []; for (; i < L.length && L[i].startsWith('|'); i++) rows.push(L[i]);
  const cells = r => r.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  const head = cells(rows[0]); const body = rows.slice(2).map(cells).slice(0, maxRows);
  const keep = head.map((_, k) => !skipCols.includes(k));
  return { head: head.filter((_, k) => keep[k]), rows: body.map(r => r.filter((_, k) => keep[k])) };
}
const mdTab = (id, caption, file, heading, widths, x = {}) => { const t = mdTable(file, heading, x); return tab(id, caption, t.head, t.rows, widths ?? t.head.map(() => 1), { note: `Transcribed programmatically from \`${file}\`, section “${heading}”.` + (x.note ? ' ' + x.note : '') }); };

module.exports.ch4 = () => [
  h1('4', 'Conclusion'),
  h2('4.1', 'Outcome'),
  p('The project set out to test whether a transformer model in the browser can be managed as separately loaded components, so that memory use and download cost adapt to the device while accuracy stays within a stated bound. A complete system was built and evaluated for DistilBERT-SST2: an offline pipeline that splits the model losslessly into four ONNX components in fp32 and int8 with two early-exit heads; a browser runtime that runs each component in its own Web Worker and releases its memory by terminating the Worker; an IndexedDB cache keyed and verified by SHA-256; a deterministic decision engine that chooses a plan under memory and accuracy constraints and explains its choice; and a package with a small public API and a demonstration page that uses only that API. Across all experiments the outputs matched the reference in every checked run (904 of 904 cloud rows with an output check; 268 of 268 Mac runs with an output check, which excludes the 10 MAC-4 session-creation rows), and the 40 unit tests pass.'),
  h2('4.2', 'Major findings'),
  p('The findings below are stated separately for the cloud machine (CLOUD-HL-1T) and the Mac (MAC-CHROME-*), with the strength of the evidence as classified in Section 3.13.'),
  ol('**Memory can be controlled by the execution shape** (supported). Loading one component at a time lowered peak memory by 55–57% against the unsplit model in the cloud, at a 50–72% higher time to first inference. The Mac produced identical peak values, so memory results reproduce across the two platforms while times do not.',
     '**Releasing a session freed no memory; terminating its Worker did.** In the cloud browser’s page-level memory measurement, `session.release()` freed 0% of the added memory and `worker.terminate()` returned the page to its 2.8 MiB starting level. This was measured in the cloud only and concerns the memory the browser attributes to the page, not memory returned to the operating system. It is the basis of the architecture.',
     '**The cache removes the download on revisits** (supported). Revisits downloaded 0 bytes in the cloud; the TTFI speed-up grew from ×1.16–1.34 on localhost to ×52–78 at 5 Mbit/s. It was not measured on the Mac.',
     '**Early exit lowers latency** (supported on both machines): −18.6 to −20.4% (cloud) and −21.0 to −21.2% (Mac) in resident plans, smaller in sequential plans. Its accuracy cost (−0.11 to −0.34 points) is **not statistically significant** at n = 872, and its byte saving holds only for single cold requests that exit early.',
     '**Mixed precision is a descriptive improvement only.** mixedC2 is on the accuracy-versus-bytes Pareto front and recovers 77.8% of the int8–fp32 gap, but no precision difference is significant on 872 sentences.',
     '**Pre-starting the next component does not shorten time to first inference** (H2 not supported, cloud), although it shortens a multi-sentence workload by 18–27% at a memory cost.',
     '**The decision engine is memory-safe but its time model is incomplete.** Memory was never under-predicted (0 of 200 cloud runs, 0 of 180 Mac runs). Time was 28–52% (cloud) and 15–29% (Mac) optimistic for pre-start and pinned plans, which caused a 24–43% regret for the mid profile in the cloud. On the Mac every decision was best among the engine’s own top four plans, a narrower test.',
     '**Device and platform matter for int8 speed and native results.** int8 was faster than fp32 in the cloud but never faster on the Mac. Native ONNX Runtime int8 results differed by CPU architecture and runtime version, while the WebAssembly results were identical everywhere.'),
  h2('4.3', 'Limitations'),
  p('The eleven limitations accepted at the end of Phase 7 (results report §16) apply to every result in this report:'),
  ol('**Two machines, not a controlled CPU experiment.** They differ in operating system, browser build, headless versus headed mode and protocol; simulated CPU throttling could not reach Workers (F-33).',
     '**Mac protocol.** A tab reload keeps the compiled WebAssembly module (F-37), so Mac creation and cold-start times are not comparable with the cloud.',
     '**Time model.** Optimistic for pre-start and pinned plans and pessimistic for cold resident plans on both machines; the refit only moved the error, so it was not applied.',
     '**Mac regret** was measured on a narrower plan set (each decision only against the engine’s own top four predicted plans); the mid-profile regret is confirmed in the cloud only.',
     '**Statistical power.** 872 sentences cannot separate the precision settings (int8 vs fp32 p = 0.064) or the early-exit loss; five timing repetitions give wide intervals in some cells (for example Mac int8 with 4 threads [16.75, 24.06] ms).',
     '**One model, task and data set.** The cost model and accuracy table are specific to DistilBERT-SST2, and τ was tuned on a development split of the training data.',
     '**Network.** Links were simulated by a token-bucket server on localhost (+3.2% at 50 Mbit/s; first-byte delay 20 ms), fp32 at 5 Mbit/s was omitted, and the Mac had no throttled network.',
     '**Memory probe.** It sees WebAssembly heaps only (JavaScript heaps added 4–10 MiB in spot checks); pre-start plans are reported with lower and upper bounds.',
     '**Unexplained single observations** are kept: I-4.8, F-14, the pilot’s 11.1 s fp32 baseline TTFI, and the first Mac run’s slowdown.',
     '**Native int8 results depend on the CPU and the ONNX Runtime version** (F-34); only the WebAssembly results are portable.',
     '**No real low-memory device** was tested; profiles impose memory only as an engine budget.'),
  p('In addition to the accepted list, the device signals available to a web page are coarse: `deviceMemory` and `hardwareConcurrency` are browser-reported values that are rounded or capped, so the engine’s view of a real device without a profile is approximate (Section 2.8).'),
  h2('4.4', 'Future enhancements'),
  ul('**Time-prediction model.** Identify and model the cost that is missing for pre-start and pinned plans (recorded as future work on 1 November 2026), then re-measure regret, including on the Mac with the same plan set as the cloud.',
     '**Real devices and networks.** Evaluate on real low-memory phones and over real networks rather than profiles and a simulated link.',
     '**More models and tasks.** Generalise the measurement step that produces the per-component heaps, timings and accuracy table, so that the package is not specific to one model; generative models would additionally need the key–value cache to be passed between components.',
     '**Statistical power.** Use larger evaluation sets to test whether the precision and early-exit accuracy differences are real.',
     '**WebGPU back-end,** once int8 operator support allows a fair comparison with WebAssembly.',
     '**Publishing the package** to the npm registry, which was left as the author’s decision.'),
];

module.exports.refs = () => [
  h1(null, 'References'),
  p('All online sources were accessed and verified on 1 November 2026.', { run: { italics: true } }),
  ...[
    'Devlin, J., Chang, M.-W., Lee, K. and Toutanova, K. 2019. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. In: *Proceedings of NAACL-HLT 2019*. Association for Computational Linguistics. Available at: https://aclanthology.org/N19-1423/ [Accessed 1 November 2026].',
    'Efron, B. and Tibshirani, R. J. 1993. *An Introduction to the Bootstrap*. New York: Chapman & Hall.',
    'Haas, A., Rossberg, A., Schuff, D. L., Titzer, B. L., Holman, M., Gohman, D., Wagner, L., Zakai, A. and Bastien, J. F. 2017. Bringing the Web up to Speed with WebAssembly. In: *Proceedings of the 38th ACM SIGPLAN Conference on Programming Language Design and Implementation (PLDI 2017)*. Available at: https://research.google/pubs/bringing-the-web-up-to-speed-with-webassembly/ [Accessed 1 November 2026].',
    'Hugging Face. 2026. distilbert/distilbert-base-uncased-finetuned-sst-2-english (model card). WWW document. Available at: https://huggingface.co/distilbert/distilbert-base-uncased-finetuned-sst-2-english [Accessed 1 November 2026].',
    'Jacob, B., Kligys, S., Chen, B., Zhu, M., Tang, M., Howard, A., Adam, H. and Kalenichenko, D. 2018. Quantization and Training of Neural Networks for Efficient Integer-Arithmetic-Only Inference. In: *Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2018)*. Available at: https://openaccess.thecvf.com/content_cvpr_2018/html/Jacob_Quantization_and_Training_CVPR_2018_paper.html [Accessed 1 November 2026].',
    'Kang, Y., Hauswald, J., Gao, C., Rovinski, A., Mudge, T., Mars, J. and Tang, L. 2017. Neurosurgeon: Collaborative Intelligence Between the Cloud and Mobile Edge. In: *Proceedings of the 22nd International Conference on Architectural Support for Programming Languages and Operating Systems (ASPLOS 2017)*. Available at: https://www.cl.cam.ac.uk/~ey204/teaching/ACS/R244_2017_2018/papers/kang_asplos_2017.pdf [Accessed 1 November 2026].',
    'McNemar, Q. 1947. Note on the sampling error of the difference between correlated proportions or percentages. *Psychometrika*, 12(2), pp. 153–157. Available at: https://link.springer.com/doi/10.1007/BF02295996 [Accessed 1 November 2026].',
    'MDN Web Docs. 2026a. Web Workers API. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API [Accessed 1 November 2026].',
    'MDN Web Docs. 2026b. Transferable objects. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects [Accessed 1 November 2026].',
    'MDN Web Docs. 2026c. crossOriginIsolated global property. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/CrossOriginIsolated [Accessed 1 November 2026].',
    'MDN Web Docs. 2026d. IndexedDB API. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API [Accessed 1 November 2026].',
    'MDN Web Docs. 2026e. SubtleCrypto: digest() method. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest [Accessed 1 November 2026].',
    'MDN Web Docs. 2026f. StorageManager. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager [Accessed 1 November 2026].',
    'MDN Web Docs. 2026g. Navigator: deviceMemory property. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory [Accessed 1 November 2026].',
    'MDN Web Docs. 2026h. Navigator: hardwareConcurrency property. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency [Accessed 1 November 2026].',
    'MDN Web Docs. 2026i. NetworkInformation. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation [Accessed 1 November 2026].',
    'MDN Web Docs. 2026j. Performance: measureUserAgentSpecificMemory() method. WWW document. Available at: https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory [Accessed 1 November 2026].',
    'ONNX. 2026. Introduction to ONNX. WWW document. Available at: https://onnx.ai/onnx/intro/ [Accessed 1 November 2026].',
    'ONNX Runtime. 2026a. Get started with ONNX Runtime Web. WWW document. Available at: https://onnxruntime.ai/docs/get-started/with-javascript/web.html [Accessed 1 November 2026].',
    'ONNX Runtime. 2026b. Quantize ONNX models. WWW document. Available at: https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html [Accessed 1 November 2026].',
    'PyTorch. 2026. torch.onnx. WWW document. Available at: https://docs.pytorch.org/docs/stable/onnx.html [Accessed 1 November 2026].',
    'Sanh, V., Debut, L., Chaumond, J. and Wolf, T. 2019. DistilBERT, a distilled version of BERT: smaller, faster, cheaper and lighter. arXiv:1910.01108. Available at: https://arxiv.org/abs/1910.01108 [Accessed 1 November 2026].',
    'Socher, R., Perelygin, A., Wu, J., Chuang, J., Manning, C. D., Ng, A. and Potts, C. 2013. Recursive Deep Models for Semantic Compositionality Over a Sentiment Treebank. In: *Proceedings of EMNLP 2013*. Available at: https://aclanthology.org/D13-1170/ [Accessed 1 November 2026].',
    'Sommerville, I. 2016. *Software Engineering*. 10th edn. Harlow: Pearson.',
    'Teerapittayanon, S., McDanel, B. and Kung, H. T. 2016. BranchyNet: Fast Inference via Early Exiting from Deep Neural Networks. In: *Proceedings of the 23rd International Conference on Pattern Recognition (ICPR 2016)*. Available at: https://arxiv.org/abs/1709.01686 [Accessed 1 November 2026].',
    'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł. and Polosukhin, I. 2017. Attention Is All You Need. In: *Advances in Neural Information Processing Systems 30 (NIPS 2017)*. Available at: https://proceedings.neurips.cc/paper/7181-attention-is-all [Accessed 1 November 2026].',
    'W3C. 2026. Device Memory API (Working Draft, 30 March 2026). WWW document. Available at: https://www.w3.org/TR/2026/WD-device-memory-1-20260330/ [Accessed 1 November 2026].',
    'Wang, A., Singh, A., Michael, J., Hill, F., Levy, O. and Bowman, S. 2018. GLUE: A Multi-Task Benchmark and Analysis Platform for Natural Language Understanding. In: *Proceedings of the 2018 EMNLP Workshop BlackboxNLP*. Available at: https://aclanthology.org/W18-5446/ [Accessed 1 November 2026].',
    'Xin, J., Tang, R., Lee, J., Yu, Y. and Lin, J. 2020. DeeBERT: Dynamic Early Exiting for Accelerating BERT Inference. In: *Proceedings of ACL 2020*. Available at: https://aclanthology.org/2020.acl-main.204 [Accessed 1 November 2026].',
  ].map(r => ({ t: 'ul', items: [r] })),
];

// ---------- appendices ----------
function findingsRows() {
  const L = rd('docs/FINDINGS.md').split('\n').filter(l => /^\| \**[FD]-\d+/.test(l));
  return L.map(l => {
    const c = l.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(x => x.trim());
    let f = c[1].replace(/\\\|/g, '|'); const m = f.match(/^\*\*(.+?)\*\*/); let s = m ? m[1] : f.split(/(?<=\.)\s/)[0];
    if (s.length > 230) s = s.slice(0, 227) + '…';
    let st = c[4].replace(/\*\*/g, ''); st = st.split(/[.;(]/)[0].replace(/:.*$/, '').trim(); if (st.length > 60) st = st.slice(0, 57) + '…';
    return [c[0].replace(/\*/g, ''), s.replace(/\*\*/g, ''), c[2].replace(/\*/g, ''), st];
  }).sort((a, b) => (a[0][0] === b[0][0] ? +a[0].slice(2) - +b[0].slice(2) : a[0] < b[0] ? 1 : -1));
}
function configRows() {
  const c = JSON.parse(rd('bench/configs.json')).configurations;
  return Object.entries(c).map(([k, v]) => [k, [v.device, v.os].filter(Boolean).join('; '), v.browser ?? v.runtime ?? v.environment ?? '', String(v.threads ?? '—')]);
}
const R = 'docs/phase-reports/PHASE_7_RESULTS_REPORT.md', M = 'docs/phase-reports/PHASE_7_MAC_RESULTS.md';

module.exports.app = () => [
  h1(null, 'Appendix A  Findings register'),
  p('Condensed from `docs/FINDINGS.md` (one row per finding: the finding’s headline sentence, the phase, and its status). Findings F-28 to F-32 were documented in the Phase 5 report (§4) but had not been transcribed into the register; on 1 November 2026 they were added with their finding text copied unchanged from that report (checked to be identical), phase 5, and the status “Observed”, which was assigned at transcription because the Phase 5 table has no status column. The Phase 5 report itself is unchanged. The register keeps every entry; superseded or updated entries are marked there.'),
  tab('a-findings', 'Findings register (condensed).', ['ID', 'Finding (headline)', 'Phase', 'Status'], findingsRows(), [0.6, 5.6, 0.8, 1.6]),

  h1(null, 'Appendix B  Detailed Phase 7 statistics (Part A: cloud and offline)'),
  p('The tables in this appendix are transcribed programmatically from the final results report, which was itself generated from the raw data by `bench/phase7/analyze.mjs`. Medians with [bootstrap 95% CI], n = 5 per timing configuration unless stated.'),
  mdTab('b-e1', 'E1: peak memory, TTFI and M4 latency by policy and precision (CLOUD-HL-1T, cache off).', R, '3. E1', [1.3, 0.9, 1, 0.9, 0.8, 1.3, 1.6, 0.8]),
  mdTab('b-e3lat', 'E3: early-exit latency and compute (CLOUD-HL-1T).', R, '4.2 Latency', [1, 0.8, 1.6, 1.8, 1.1, 1.6]),
  mdTab('b-e3b', 'E3: bytes for single cold requests by exit class (CLOUD-HL-1T).', R, '4.3 Bytes', [1, 1.2, 1.2, 1.3, 1.3]),
  mdTab('b-e2', 'E2: pre-start, TTFI and 100-sentence workload (CLOUD-HL-1T-NET-*).', R, '5. E2', [1, 0.8, 1.2, 1.3, 1.3, 1.3, 1.1, 1.1]),
  mdTab('b-e4', 'E4: all 16 precision combinations (NODE-WASM-X86, 872 sentences).', R, '7. E4', [1.4, 0.9, 1, 1, 0.9, 0.8, 1]),
  mdTab('b-eb', 'E-B: int8 batch dependence, flips vs batch 1 (of 872) and accuracy.', R, '8. E-B', [1.6, 0.8, 1.8, 1.4, 1.4, 1.6]),
  mdTab('b-f5', 'F-5: native vs WASM at batch 1.', R, '9. F-5', [1.6, 1.2, 0.8, 0.8, 0.6, 0.9, 0.9, 0.9]),
  mdTab('b-f28', 'E-F28: session creation time by state (400 creations, n = 40 per cell).', R, '10. E-F28', [2.4, 1.2, 1.2, 2]),
  mdTab('b-regret', 'E-ENG: decisions, rank and regret (CLOUD-HL-1T).', R, '11.3 Decisions', [0.7, 0.8, 1.9, 1, 1, 1.1, 1.3]),
  mdTab('b-refit', 'E-ENG: I-5.1 refit, proposal only (not applied).', R, '11.4 I-5.1', [1.6, 1.1, 1.6, 1.6]),
  mdTab('b-dev', 'Deviations and unexpected findings, Part A.', R, '12. Deviations', [0.5, 5, 0.8]),

  h1(null, 'Appendix C  Detailed Mac results (Part B)'),
  p('Transcribed programmatically from `docs/phase-reports/PHASE_7_MAC_RESULTS.md` and the results report Part B. These values are never combined with Appendix B.'),
  mdTab('c-runs', 'Mac result files and their use.', M, 'Phase 7: Mac Results', [1.6, 3.2, 1, 3]),
  mdTab('c-mac1', 'MAC-1: thread sweep (original run), baseline, w100.', R, '13.1 MAC-1', [0.8, 1.4, 1.4, 1.6, 1.2, 1.2]),
  mdTab('c-mac3', 'MAC-3: policies and early exit (re-run).', R, '13.2 MAC-3', [1.6, 1.1, 1.4, 1.8, 1.1]),
  mdTab('c-mac2d', 'MAC-2: decisions compared with the cloud’s.', M, '5.1 Decisions', [0.8, 0.8, 2.6, 2.4]),
  mdTab('c-mac2r', 'MAC-2: regret and rank (top-4 predicted plans only).', M, '5.4 Regret', [2.2, 1.6, 0.8, 1.6]),
  mdTab('c-mac5', 'MAC-5: F-14 fetch diagnostic, six rounds.', R, '13.5 MAC-5', [1.4, 1, 1, 1, 1, 1, 1]),

  h1(null, 'Appendix D  Experiment configurations'),
  p('All configurations registered in `bench/configs.json` (generated from the file). Results from different configurations are never averaged together, and each result file names exactly one configuration.'),
  tab('d-configs', 'Registered configurations.', ['Configuration', 'Device; OS', 'Browser / runtime', 'Threads'], configRows(), [2.1, 3.1, 3.3, 0.6], { size: 16 }),

  h1(null, 'Appendix E  Raw-data index'),
  p('All raw data are preserved in the repository. Nothing was deleted, including failed attempts (kept as rows with `retryOf`), pilot and smoke-test data, and the invalid part of the first Mac run.'),
  mdTab('e-raw', 'Phase 7 raw-data index (results report §17).', R, '17. Raw-data index', [2, 5]),
  tab('e-counts', 'File counts in `results/phase7/` at the time of writing (proposed Phase 7 commit).', ['Folder', 'Files', 'Folder', 'Files'], [
    ['`net` (incl. 80 `profile_*.txt` throttling logs)', '97', '`eng`', '8'], ['`wasm`', '90', '`e1`, `e3bytes`, `native-x86-ort1.29.0`', '5 each'],
    ['`native-x86-ort1.20.1`', '77', '`acc`, `f28`', '4 each'], ['`native-arm64-ort1.20.1`', '77', '`ebrowser`, `g1`, `mac`, `netcheck`, `summary`', '3 each'],
    ['`_smoke` (not results)', '43', '`workload_100.json`', '1'], ['`e5x`', '39', '**Total**', '**494**'], ['`pilot` (not results)', '24', '', ''],
  ], [3, 0.8, 3, 0.8], { note: 'Earlier phases’ raw results are in `results/phase1` to `results/phase6` and are referenced from their phase reports.' }),

  h1(null, 'Appendix F  Repository structure and reproduction'),
  tab('f-repo', 'Repository structure (top level).', ['Path', 'Contents'], [
    ['`python/`', 'Model pipeline (`run_phase1.sh`, split, export, quantize, exit heads, validate, manifest) and diagnostics'],
    ['`models/onnx/`', '`manifest.json`, `early_exit.json`, `vocab.txt` (tracked); ONNX files (generated, not tracked)'],
    ['`packages/adaptive-onnx-loader/`', 'The package: `src/`, `test/`, `index.d.ts`, `README.md`, `LICENSE` (MIT)'],
    ['`demo/`', '`server.mjs` and the demonstration pages for Phases 2–6'],
    ['`bench/`', 'Browser tests per phase, Phase 7 harness and analysis (`bench/phase7/`), `configs.json`'],
    ['`results/`', 'Raw results and analyses per phase'],
    ['`docs/`', 'Master plan, findings register, experiment plan, phase reports, this report (`docs/final-report/`)'],
    ['`scripts/fetch_resources.sh`', 'Downloads the checkpoint and SST-2 files'],
  ], [2.6, 5.4]),
  p('**Reproduction outline** (commands as documented in the phase reports):'),
  ol('`scripts/fetch_resources.sh`: download the checkpoint and data (needs access to huggingface.co).',
     '`python/run_phase1.sh`: rebuild the ONNX components, exit heads and manifest.',
     '`npm test` in `packages/adaptive-onnx-loader`: unit tests (40).',
     '`node demo/server.mjs`, then open `http://localhost:8080/` for the demonstration page.',
     '`node bench/phase7/suite.mjs` and `node bench/phase7/validate.mjs <block>` for the cloud experiments; `node bench/phase7/analyze.mjs` regenerates `results/phase7/summary/analysis.json` from the raw files.',
     'For the report itself: `docs/final-report/tools/make_charts.py` regenerates the charts from the summary files; `capture_screenshots.mjs` regenerates the documentation screenshots; `src/build.js` builds this document.'),
];
