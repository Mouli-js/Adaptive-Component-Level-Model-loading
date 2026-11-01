"""Render the DOCX to PDF (LibreOffice), locate headings and captions, and write src/pages.json for the static
contents lists. Body pages are numbered from the first chapter page; front matter in roman numerals from page 2."""
import json, subprocess, sys, os, re
FR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
docx = os.path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx'); outdir = os.path.join(FR, 'build'); os.makedirs(outdir, exist_ok=True)
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', outdir, docx], check=True, capture_output=True, timeout=600)
pdf = os.path.join(outdir, 'MCA_Project1_Final_Report_DRAFT.pdf')
n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout).group(1))
pages = [subprocess.run(['pdftotext', '-f', str(i), '-l', str(i), '-layout', pdf, '-'], capture_output=True, text=True).stdout for i in range(1, n + 1)]
L = json.load(open(os.path.join(FR, 'src', 'lists.json')))
norm = lambda s: re.sub(r'\s+', ' ', s).strip()
lines = [[norm(l) for l in pg.splitlines() if l.strip()] for pg in pages]
def top(i):  # first text line of a page, skipping a bare page number in the header
    ls = [l for l in lines[i] if not re.fullmatch(r'[ivxlc]+|\d+', l)]
    return ls[0] if ls else ''
c0 = next(i for i in range(n) if top(i) == 'Contents'); a0 = next(i for i in range(n) if top(i) == 'List of Abbreviations')
listpages = set(range(c0, a0))
def find(text, start=0, caption=False):
    t = norm(text)[:45]
    for i in range(start, n):
        if i in listpages and not (top(i) == t): continue
        for l in lines[i]:
            if l.startswith(t): return i
    return None
def roman(k):
    v = [(10, 'x'), (9, 'ix'), (5, 'v'), (4, 'iv'), (1, 'i')]; s = ''
    for a, r in v:
        while k >= a: s += r; k -= a
    return s
# skip the contents/list pages when searching: start after the List of Abbreviations heading
body0 = next(i for i in range(n) if top(i).startswith('1 Introduction'))
res, cur = {}, 1
for e in L['toc']:
    i = find(e['find'], cur if e['body'] else 1) if e['body'] else next((k for k in range(1, body0) if top(k) == norm(e['find'])), None)
    if i is None: print('NOT FOUND', e); continue
    res[e['key']] = str(i - body0 + 1) if e['body'] else roman(i)  # physical i (0-based): front roman = i (title page = 0)
    if e['body']: cur = i
for kind in ('fig', 'tab'):
    cur = 1
    for e in L[kind]:
        i = find(e.get('text', e['find']), cur, caption=True)
        if i is None: print('NOT FOUND', e); continue
        res[e['key']] = str(i - body0 + 1) if i >= body0 else roman(i); cur = i
json.dump(res, open(os.path.join(FR, 'src', 'pages.json'), 'w'), indent=0)
print('pages', n, 'body starts at physical', body0 + 1, 'body pages', n - body0, 'entries', len(res))
