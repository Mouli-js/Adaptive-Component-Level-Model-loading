"""Post-process the DOCX written by src/build.js:
  * caption numbers become Word SEQ fields (SEQ Figure / SEQ Table), with the current number as the cached result;
  * the Contents, List of Figures and List of Tables become Word TOC fields
      TOC \\o "1-3" \\h \\z \\u        (headings)
      TOC \\h \\z \\c "Figure"         (captions numbered with SEQ Figure)
      TOC \\h \\z \\c "Table"
    whose cached results are the entries with a right-aligned, dot-leader page number taken from the last render
    (src/pages.json), so the file reads correctly before Word updates it;
  * settings.xml asks Word to update all fields when the document is opened (Word then re-paginates the lists itself).
Usage: python3 finalize.py   (edits MCA_Project1_Final_Report_DRAFT.docx in place)"""
import json, os, re, shutil, zipfile, tempfile
from xml.sax.saxutils import escape
FR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DOCX = os.path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx')
L = json.load(open(os.path.join(FR, 'src', 'lists.json')))
pages_path = os.path.join(FR, 'src', 'pages.json')
P = json.load(open(pages_path)) if os.path.exists(pages_path) else {}

RPR = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>{b}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>'
def run(text, bold=False): return f'<w:r>{RPR.format(b="<w:b/>" if bold else "")}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'
def tab(bold=False): return f'<w:r>{RPR.format(b="<w:b/>" if bold else "")}<w:tab/></w:r>'
FB = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
def instr(t): return f'<w:r><w:instrText xml:space="preserve"> {escape(t)} </w:instrText></w:r>'
FS = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
FE = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

def field_block(instruction, entries):
    """entries: list of (style, text, page, bold). Field begins in the first paragraph and ends in the last."""
    out = []
    for i, (style, text, page, bold) in enumerate(entries):
        pre = (FB + instr(instruction) + FS) if i == 0 else ''
        post = FE if i == len(entries) - 1 else ''
        out.append(f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{pre}{run(text, bold)}{tab(bold)}{run(str(page), bold)}{post}</w:p>')
    return ''.join(out)

toc_entries = [(f'TOC{e["level"]}', e['text'], P.get(e['key'], ''), e['level'] == 1) for e in L['toc']]
lof_entries = [('TableofFigures', e['text'], P.get(e['key'], ''), False) for e in L['fig']]
lot_entries = [('TableofFigures', e['text'], P.get(e['key'], ''), False) for e in L['tab']]

tmp = tempfile.mkdtemp()
with zipfile.ZipFile(DOCX) as z: z.extractall(tmp)
docp = os.path.join(tmp, 'word', 'document.xml'); s = open(docp, encoding='utf-8').read()

# 1. SEQ fields in captions
n_seq = 0
def seq(m):
    global n_seq; n_seq += 1
    rpr, kind, num = m.group(1) or '', m.group(2), m.group(3)
    return (f'<w:r>{rpr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>{rpr}<w:instrText xml:space="preserve"> SEQ {kind} \\* ARABIC </w:instrText></w:r>'
            f'<w:r>{rpr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>{rpr}<w:t>{num}</w:t></w:r><w:r>{rpr}<w:fldChar w:fldCharType="end"/></w:r>')
s = re.sub(r'<w:r>(<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t(?: [^>]*)?>§SEQ:(\w+):(\d+)§</w:t></w:r>', seq, s)
assert '§SEQ' not in s, 'unreplaced SEQ marker'

# 2. TOC / LOF / LOT fields
def replace_marker(s, name, block):
    pat = re.compile(r'<w:p>(?:(?!<w:p>).)*?§' + name + r'§(?:(?!<w:p>).)*?</w:p>', re.S)
    s2, k = pat.subn(lambda m: block, s, count=1); assert k == 1, name; return s2
s = replace_marker(s, 'TOC', field_block('TOC \\o "1-3" \\h \\z \\u', toc_entries))
s = replace_marker(s, 'LOF', field_block('TOC \\h \\z \\c "Figure"', lof_entries))
s = replace_marker(s, 'LOT', field_block('TOC \\h \\z \\c "Table"', lot_entries))
open(docp, 'w', encoding='utf-8').write(s)

# 2b. header page numbers: PAGE field with an explicit format switch
hdr_done = 0
for hf in sorted(os.listdir(os.path.join(tmp, 'word'))):
    if not hf.startswith('header'): continue
    hp = os.path.join(tmp, 'word', hf); h = open(hp, encoding='utf-8').read()
    def pagefield(m):
        rpr, fmt = m.group(1) or '', m.group(2)
        return (f'<w:r>{rpr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>{rpr}<w:instrText xml:space="preserve"> PAGE \\* {fmt} </w:instrText></w:r>'
                f'<w:r>{rpr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>{rpr}<w:fldChar w:fldCharType="end"/></w:r>')
    h2, k = re.subn(r'<w:r>(<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t(?: [^>]*)?>§PAGE:(\w+)§</w:t></w:r>', pagefield, h)
    hdr_done += k; open(hp, 'w', encoding='utf-8').write(h2)
assert hdr_done == 2, hdr_done

# 3. update fields on open
sp = os.path.join(tmp, 'word', 'settings.xml'); st = open(sp, encoding='utf-8').read()
if '<w:updateFields' not in st:
    st = st.replace('<w:compat>', '<w:updateFields w:val="true"/><w:compat>', 1)   # schema order: updateFields precedes compat
    assert '<w:updateFields' in st
open(sp, 'w', encoding='utf-8').write(st)

out = DOCX + '.tmp'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    allf = sorted((os.path.relpath(os.path.join(r, f), tmp) for r, _, fs in os.walk(tmp) for f in fs), key=lambda a: (a != '[Content_Types].xml', a))
    for arc in allf: z.write(os.path.join(tmp, arc), arc)
shutil.move(out, DOCX); shutil.rmtree(tmp)
missing = [e for e in toc_entries + lof_entries + lot_entries if e[2] == '']
print(f'finalize: {n_seq} SEQ fields; TOC {len(toc_entries)}, LOF {len(lof_entries)}, LOT {len(lot_entries)} entries; {len(missing)} without page numbers')
