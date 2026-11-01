"""Every in-text (Author Year) citation has a bibliography entry, and every bibliography entry is cited."""
import re, subprocess, os, sys
FR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
t = subprocess.run(['pandoc', '-t', 'plain', '--wrap=none', os.path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx')], capture_output=True, text=True).stdout
start = t.index('\n1    Introduction\n') if '\n1    Introduction\n' in t else t.index('Background and motivation')
body = t[start:t.rindex('\nReferences\n')]; refs = t[t.rindex('\nReferences\n'):t.index('Appendix A', t.rindex('\nReferences\n'))]
cited = set()
for grp in re.findall(r'\(([^()]*?\b(?:19|20)\d\d[a-z]?[^()]*?)\)', body):
    for part in grp.split(';'):
        for m in re.finditer(r'((?:[A-Z][\w\-]*\s?)+?(?:et al\.|and [A-Z][a-z]+)?)\s((?:19|20)\d\d[a-z]?)\b', part):
            a = m.group(1).strip().replace(' et al.', '').split(' and ')[0]
            if a not in ('Nov', 'November'): cited.add((a, m.group(2)))
bib = set()
for line in refs.split('\n'):
    m = re.match(r'\s*[-•]?\s*(.+?)[,.]\s.*?\b((?:19|20)\d\d[a-z]?)\.\s', line)
    if m and 'accessed and verified' not in line: bib.add((m.group(1).split(',')[0].strip(), m.group(2)))
bk = {(a.split()[0] if a not in ('MDN Web Docs', 'ONNX Runtime', 'Hugging Face') else a, y) for a, y in bib}
ck = {(a.split()[0] if a not in ('MDN Web Docs', 'ONNX Runtime', 'Hugging Face') else a, y) for a, y in cited}
print('cited:', len(ck), 'bibliography:', len(bk))
print('cited but not in bibliography:', sorted(ck - bk)); print('in bibliography but not cited:', sorted(bk - ck))
sys.exit(1 if (ck - bk) or (bk - ck) else 0)
