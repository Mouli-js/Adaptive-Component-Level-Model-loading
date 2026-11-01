# Final MCA report: working folder

**Status:** first complete draft, for review. Not committed.

| Item | Path |
|---|---|
| Report (Word) | `MCA_Project1_Final_Report_DRAFT.docx` |
| PDF render of the same file (LibreOffice; for review only) | `build/MCA_Project1_Final_Report_DRAFT.pdf` |
| Evidence map (every figure, code excerpt and table with its source) | `EVIDENCE_MAP.md` |
| Report content (text of every chapter) | `src/content*.js` |
| Document builder (layout, numbering, code excerpts read verbatim from the repo) | `src/build.js` |
| Diagrams (Graphviz / Mermaid / matplotlib sources + PNGs) | `figures/diagrams/`, `figures/diagrams/src/` |
| Charts from `results/phase7/summary/*.json` | `figures/charts/`, `tools/make_charts.py` |
| Documentation screenshots (unchanged demo pages, CLOUD-HL) | `figures/screenshots/`, `tools/capture_screenshots.mjs` |
| Application-generated IndexedDB view used for Figure 22 | `tools/idb_view.html` |
| Page numbers for the static contents lists | `tools/paginate.py` → `src/pages.json` |
| Number check against the source corpus | `tools/check_numbers.py` |

## Rebuild and check

```bash
python3 docs/final-report/tools/make_charts.py               # charts (reads results/phase7/summary only)
node docs/final-report/tools/capture_screenshots.mjs          # screenshots (needs models/onnx and Playwright)
docs/final-report/tools/run_all.sh                            # build → Word fields → LibreOffice render → page numbers, until stable
python3 docs/final-report/tools/verify_render.py              # page labels, contents/figure/table page numbers, cross-references, page border, fields
python3 docs/final-report/tools/check_citations.py            # every (Author Year) citation has a bibliography entry and vice versa
python3 docs/final-report/tools/check_numbers.py              # every number in the text occurs in the source corpus
```

The Contents, List of Figures and List of Tables are Word TOC fields (`TOC \o "1-3" \h \z \u`, `TOC \h \z \c "Figure"`, `TOC \h \z \c "Table"`), and caption numbers are `SEQ` fields. Their stored results carry the page numbers of the checked LibreOffice render. The document asks Word to update fields when it is opened, so Word re-paginates the lists with its own layout. Word shows a prompt for this; choose Yes.

Nothing in the engine, package, baseline, demo, experimental results or raw data was modified to produce this report.
