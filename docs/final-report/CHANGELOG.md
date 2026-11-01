# Report change log

## Draft 3 (1 Nov 2026), after the review of draft 2

1. **Front-matter numbering.** The header page numbers are now `PAGE \* roman` (front matter) and `PAGE \* Arabic` (Chapter 1 onward). These explicit field switches are in addition to the section number formats, so the numbering no longer depends on a renderer honouring the section's number format. In a test render with the section formats removed, the front matter still printed i–x and Chapter 1 still started at 1.
2. **Pagination and fields.** The document was rebuilt and re-rendered until stable, and every Contents, figure and table entry was checked against the printed page: 55 + 84 entries, 0 mismatches, 85 pages (11 front matter + 74 body). Appendix E is on 73 and Appendix F on 74 in this render. Two dense tables (Table 5, Table 46) now use a slightly smaller font, so the pages before a part break have more spare room. The table content is unchanged.
3. **Visible page border.** Each header now carries a full-page frame (a transparent image with a 1.5 pt rectangle) anchored behind the text. It sits exactly on the Word page border, so Word and LibreOffice show one line. Renderers that ignore Word page borders still show the frame; this was tested by removing the page-border setting, and the frame was visible on all four sides of all 85 pages.

No technical content, conclusions, results, engine, package or raw data changed.


## Draft 2 (1 Nov 2026), after the review of draft 1

**Formatting**

1. Bonafide certificate: the signature blocks are a borderless two-column table (guide | head), with a separate date and seal row. Draft 1 used tab characters, which Word ignores inside text.
2. Contents, List of Figures and List of Tables are Word TOC fields. Their entries have right-aligned page numbers with dot leaders, styled TOC 1–3 and Table of Figures. Caption numbers are SEQ fields. The “Contents” title no longer uses a heading style, so it does not list itself. Cause of the draft 1 problem: the page numbers were separated by a literal tab character inside the text run, which Word drops (“Abstractii”).
3. Page numbering: the title page is unnumbered, the front matter is numbered i–x, and Arabic numbering restarts at 1 on Chapter 1. Verified page by page against the render.
4. Page border: a single-line border is defined in all three DOCX sections and verified as drawn on all four sides of all 85 PDF pages.
5. Captions: the first sentence stays in the caption, which is what Word's List of Figures and List of Tables show. Any further caption text, such as the source file and lines of code excerpts, is kept in a smaller line directly below. No caption text was removed.

**Evidence and wording**

6. 237 / 474 candidates re-counted from `generateCandidates()`: 79 per precision = 6 sequential + 72 hybrid + 1 resident; 474 = each plan with and without early exit. The weighted-cost formula is now written out exactly as implemented in `planner.js`, including the network term (N + 1)/(N_min + 1) with w_n = 0 in all profiles. Diagram D12 is updated to match.
7. Mac output checks: 268 = MAC-1 48 + MAC-3 40 + MAC-2 180. The 10 MAC-4 session-creation rows carry no output check. Stated in Table 24 and Section 4.1.
8. MAC-5: the six rounds were re-checked against `results/phase7/mac/mac5_diag_fetch_transcribed.json`. Every value matches, int8 is faster in every round, and the byte-rate ratio is 1.13–3.67. No text change was needed.
9. F-28 to F-32: the finding text in `docs/FINDINGS.md` was checked to be identical to Phase 5 report §4. The Appendix A note now states that phase 5 and the status “Observed” were assigned at transcription.
10. Mac regret: the top-four qualification is kept in Section 3.13.4, Tables 26 and 27, Section 4.2, Appendix C, and now also in Limitation 4.
11. Worker termination: the wording now matches the evidence, which is one cloud measurement per precision of the memory the browser attributes to the page. The report no longer claims memory is returned to the operating system or the device, or that terminating is the “only” way. Changed in the Abstract, §1.1, Objective 2, §2.6, §3.1, §3.6, §4.1, §4.2 item 2, and the D8 and D9 diagram labels.
12. Citations: in-text “MDN 2026x” is now “MDN Web Docs 2026x” and “Efron & Tibshirani” is now “Efron and Tibshirani”, matching the bibliography. All 29 citations match the 29 entries.

**Unchanged:** structure, conclusions, results, unsupported findings, limitations, diagrams (except the label wording in D8, D9 and D12), charts, code excerpts and appendices.
