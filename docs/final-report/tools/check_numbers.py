"""Verification aid: list every number in the report text that does not occur in the source corpus
(phase reports, plans, findings, tracker, configs, analysis JSON, package sources). Misses must be reviewed by hand."""
import subprocess, re, glob, os, json, sys
FR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..')); REPO = os.path.abspath(os.path.join(FR, '../..'))
txt = subprocess.run(['pandoc', '-t', 'plain', '--wrap=none', os.path.join(FR, 'MCA_Project1_Final_Report_DRAFT.docx')], capture_output=True, text=True).stdout
files = glob.glob(f'{REPO}/docs/**/*.md', recursive=True) + glob.glob(f'{REPO}/*.md') + [f'{REPO}/bench/configs.json'] \
  + glob.glob(f'{REPO}/results/phase7/summary/*.json') + glob.glob(f'{REPO}/packages/adaptive-onnx-loader/src/**/*.js', recursive=True) \
  + glob.glob(f'{REPO}/python/**/*.py', recursive=True) + glob.glob(f'{REPO}/results/phase7/*/env_*.json') + [f'{REPO}/models/onnx/manifest.json', f'{REPO}/packages/adaptive-onnx-loader/package.json']
files = [f for f in files if '/final-report/' not in f]
norm = lambda s: s.replace(',', '').replace('−', '-').replace('–', '-').replace(' ', '').replace('×', 'x')
corpus = norm('\n'.join(open(f, errors='ignore').read() for f in files))
# exclude references and code-excerpt text is still included (it is verbatim)
body = txt.split('References')[0] if False else txt
nums = re.findall(r'(?<![\w.])[-−]?\d[\d,]*\.?\d*(?:e-?\d+)?', body)
miss = {}
for n in nums:
    k = norm(n).lstrip('-').rstrip('.')
    if len(k.replace('.', '')) < 3: continue
    if k not in corpus: miss[k] = miss.get(k, 0) + 1
print(len(set(norm(n) for n in nums)), 'distinct numbers;', len(miss), 'not found verbatim in sources:')
for k, v in sorted(miss.items()): print(' ', k, f'(x{v})')
