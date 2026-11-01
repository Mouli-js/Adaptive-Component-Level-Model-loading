"""Checks the final DOCX and its PDF render after pagination. Exit code 1 if any check fails.
  1. page labels: no number on the title page; lower-roman i, ii, … on the front matter; Arabic 1, 2, … from Chapter 1
  2. every Contents / List of Figures / List of Tables entry shows the page on which that heading or caption is printed
  3. cross-references: every “Figure N”, “Table N”, “Section x.y”, “Appendix X” in the text exists
  4. page border: defined in every section of the DOCX and drawn on every page of the PDF
  5. Word fields present: 3 TOC fields, one SEQ field per caption, updateFields on open"""
import json, os, re, subprocess, sys, zipfile
FR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DOCX = os.path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx'); PDF = os.path.join(FR, 'build', 'MCA_Project1_Final_Report_DRAFT.pdf')
L = json.load(open(os.path.join(FR, 'src', 'lists.json')))
fails = []; ok = lambda c, msg: (print(('PASS ' if c else 'FAIL ') + msg), None if c else fails.append(msg))
n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', PDF], capture_output=True, text=True).stdout).group(1))
pages = [subprocess.run(['pdftotext', '-f', str(i), '-l', str(i), '-layout', PDF, '-'], capture_output=True, text=True).stdout for i in range(1, n + 1)]
norm = lambda s: re.sub(r'\s+', ' ', s).strip()
lines = [[norm(l) for l in p.splitlines() if l.strip()] for p in pages]
label = [ls[0] if ls and re.fullmatch(r'[ivxlc]+|\d+', ls[0]) else None for ls in lines]

# 1. page labels
def roman(k):
    s = ''
    for a, r in [(10, 'x'), (9, 'ix'), (5, 'v'), (4, 'iv'), (1, 'i')]:
        while k >= a: s += r; k -= a
    return s
body0 = next(i for i in range(n) if len(lines[i]) > 1 and lines[i][1].startswith('1 Introduction'))
ok(label[0] is None, 'title page has no page number')
ok(all(label[i] == roman(i) for i in range(1, body0)), f'front matter numbered i–{roman(body0 - 1)} without gaps')
ok(all(label[i] == str(i - body0 + 1) for i in range(body0, n)), f'body numbered 1–{n - body0} from Chapter 1 without gaps')

# 2. lists vs printed page labels (cached entries are read from the DOCX itself)
x = zipfile.ZipFile(DOCX).read('word/document.xml').decode()
def entries(style):
    out = []
    for p in re.findall(r'<w:p>(?:(?!<w:p>).)*?</w:p>', x, re.S):
        if f'<w:pStyle w:val="{style}"/>' in p:
            t = re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p); out.append((''.join(t[:-1]), t[-1]))
    return out
toc = entries('TOC1') + entries('TOC2') + entries('TOC3'); tof = entries('TableofFigures')
c0 = next(i for i in range(n) if 'Contents' in lines[i][:2]); a0 = next(i for i in range(n) if 'List of Abbreviations' in lines[i][:2])
def where(text, caption=False):
    t = norm(text)[:45]
    for i in range(n):
        if c0 <= i < a0 and not (len(lines[i]) > 1 and lines[i][1] == t): continue
        if any(l.startswith(t) for l in lines[i][1:]): return i
    return None
bad = []
for text, pgno in toc + tof:
    i = where(text)
    if i is None or label[i] != pgno: bad.append((text[:50], pgno, None if i is None else label[i]))
ok(not bad and len(toc) == len(L['toc']) and len(tof) == len(L['fig']) + len(L['tab']),
   f'{len(toc)} contents entries and {len(tof)} figure/table entries match the printed page numbers' + (f' — mismatches: {bad[:8]}' if bad else ''))

# 3. cross-references in the body text
body = '\n'.join('\n'.join(l) for l in lines[body0:])
nf, nt = len(L['fig']), len(L['tab'])
figs = {int(k) for k in re.findall(r'Figures? (\d+)', body)}; tabs = {int(k) for k in re.findall(r'Tables? (\d+)', body)}
ok(figs <= set(range(1, nf + 1)) and tabs <= set(range(1, nt + 1)), f'all Figure (1–{nf}) and Table (1–{nt}) references exist')
heads = {e['text'].split()[0] for e in L['toc'] if e['body']}
secs = set(re.findall(r'Sections? (\d+(?:\.\d+)+)', body)) | set(re.findall(r'Sections? \d+(?:\.\d+)+ (?:and|to) (\d+(?:\.\d+)+)', body))
ok(secs <= heads, f'all {len(secs)} Section references exist' + ('' if secs <= heads else f' — missing {sorted(secs - heads)}'))
apps = set(re.findall(r'Appendi(?:x|ces) ([A-F])', body)) | set(re.findall(r'Appendices [A-F] and ([A-F])', body))
ok(apps <= set('ABCDEF'), f'Appendix references exist: {sorted(apps)}')
ok('@fig:' not in body and '@tab:' not in body and not re.search(r'§(SEQ|TOC|LOF|LOT)', ''.join(pages)), 'no unresolved markers')
caps_f = [i for i in range(n) for l in lines[i] if re.match(r'Figure \d+\. ', l)]
ok(len({int(re.match(r'Figure (\d+)', l).group(1)) for i in range(body0, n) for l in lines[i] if re.match(r'Figure \d+\. ', l)}) == nf, f'{nf} figure captions printed')

# 4. page border
secs_xml = re.findall(r'<w:sectPr.*?</w:sectPr>', x, re.S)
ok(len(secs_xml) == 3 and all('<w:pgBorders' in s and all(f'<w:{e} w:val="single"' in s for e in ('top', 'left', 'bottom', 'right')) for s in secs_xml),
   'DOCX: single-line page border defined in all 3 sections (top, left, bottom, right)')
import tempfile, shutil
from PIL import Image
def border_missing(pdf):
    tmp = tempfile.mkdtemp(); subprocess.run(['pdftoppm', '-r', '150', '-gray', pdf, os.path.join(tmp, 'b')], check=True)
    miss = []
    for k, f in enumerate(sorted(os.listdir(tmp))):
        im = Image.open(os.path.join(tmp, f)); w, h = im.size; px = im.load()
        cov = lambda pts: sum(1 for q in pts if px[q] < 160) / len(pts)
        found = {'left': max(cov([(x0, y) for y in range(int(h * .1), int(h * .9))]) for x0 in range(0, 90)) > .95,
                 'right': max(cov([(x0, y) for y in range(int(h * .1), int(h * .9))]) for x0 in range(w - 90, w)) > .95,
                 'top': max(cov([(xx, y0) for xx in range(int(w * .1), int(w * .9))]) for y0 in range(0, 90)) > .95,
                 'bottom': max(cov([(xx, y0) for xx in range(int(w * .1), int(w * .9))]) for y0 in range(h - 90, h)) > .95}
        if not all(found.values()): miss.append((k + 1, [s for s, v in found.items() if not v]))
    shutil.rmtree(tmp); return miss
missing = border_missing(PDF)
ok(not missing, f'PDF: border drawn on all four sides of all {n} pages' + (f' — missing on {missing[:6]}' if missing else ''))

# 4b. fallback: a renderer that ignores Word page borders and section number formats must still show the frame and roman numbers
import zipfile as zf
tmp = tempfile.mkdtemp(); z = zf.ZipFile(DOCX); y = z.read('word/document.xml').decode()
y = re.sub(r'<w:pgBorders.*?</w:pgBorders>', '', y, flags=re.S); y = re.sub(r' w:fmt="(lowerRoman|decimal)"', '', y)
sim = os.path.join(tmp, 'sim.docx')
with zf.ZipFile(sim, 'w', zf.ZIP_DEFLATED) as o:
    for nm in z.namelist(): o.writestr(nm, y if nm == 'word/document.xml' else z.read(nm))
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, sim], capture_output=True, timeout=600)
spdf = os.path.join(tmp, 'sim.pdf')
sl = [subprocess.run(['pdftotext', '-f', str(i), '-l', str(i), '-layout', spdf, '-'], capture_output=True, text=True).stdout.split()[:1] for i in range(2, body0 + 2)]
ok([t[0] if t else '' for t in sl] == [roman(i) for i in range(1, body0)] + ['1'], 'fallback (no pgBorders, no section number format): front matter still i–' + roman(body0 - 1) + ', Chapter 1 still 1')
sm = border_missing(spdf)
ok(not sm, 'fallback (no pgBorders): page frame still visible on all four sides of every page' + (f' — missing on {sm[:6]}' if sm else ''))
shutil.rmtree(tmp)

# 5. Word fields
ok(len(re.findall(r'<w:instrText[^>]*> TOC ', x)) == 3, 'DOCX: 3 TOC fields (contents, figures, tables)')
ok(len(re.findall(r'> SEQ Figure ', x)) == nf and len(re.findall(r'> SEQ Table ', x)) == nt, f'DOCX: {nf} SEQ Figure and {nt} SEQ Table fields')
ok('<w:updateFields w:val="true"/>' in zipfile.ZipFile(DOCX).read('word/settings.xml').decode(), 'DOCX: Word updates fields when opened')
ok('\t' not in ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', x)), 'DOCX: no literal tab characters inside text runs')
print(f'\n{n} pages ({body0} front, {n - body0} body); {len(fails)} failed check(s)')
sys.exit(1 if fails else 0)
