"""Charts C1-C6 for the final report. Reads ONLY results/phase7/summary/*.json.
Cloud (Part A) and Mac (Part B) are always separate figures. Usage: python3 docs/final-report/tools/make_charts.py"""
import json, os, sys
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
S = os.path.join(ROOT, 'results', 'phase7', 'summary')
OUT = os.path.join(ROOT, 'docs', 'final-report', 'figures', 'charts'); os.makedirs(OUT, exist_ok=True)
A = json.load(open(os.path.join(S, 'analysis.json'))); M = json.load(open(os.path.join(S, 'analysis_mac_final.json')))
COL = {'int8': '#2a78d6', 'mixedC2': '#eb6834', 'fp32': '#1baf7a', 'warm': '#2a78d6', 'cold': '#eb6834', 'off': '#8a8985', 'on': '#2a78d6'}
HATCH = {'int8': '', 'mixedC2': '///', 'fp32': '...', 'warm': '', 'cold': '///', 'off': '', 'on': '///'}
plt.rcParams.update({'font.family': 'DejaVu Serif', 'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.grid': True, 'grid.color': '#dddddd', 'grid.linewidth': 0.6, 'axes.axisbelow': True,
                     'hatch.color': 'white', 'hatch.linewidth': 0.8, 'savefig.dpi': 220})
log = []
def save(fig, name): fig.tight_layout(); fig.savefig(os.path.join(OUT, name + '.png')); plt.close(fig); log.append(name)
def bar(ax, x, h, key, label=None, **kw):
    return ax.bar(x, h, color=COL[key], hatch=HATCH[key], edgecolor='white', linewidth=0.8, label=label, **kw)

# C1 peak memory by policy, cloud E1 (early exit off), peakTotalMiB
t = A['E1']['table']; pol = ['baseline', 'chain', 'resident', 'hybrid', 'sequential']
names = ['Baseline\n(1 session)', 'Chain in page\n(4 sessions)', 'Workers:\nresident', 'Workers:\nhybrid', 'Workers:\nsequential G32']
fig, ax = plt.subplots(figsize=(6.6, 3.4)); w = 0.26
for j, pr in enumerate(['int8', 'mixedC2', 'fp32']):
    xs, hs = [], []
    for i, p in enumerate(pol):
        k = f'{p}|{pr}|ee0'
        if k in t: xs.append(i + (j - 1) * w); hs.append(t[k]['peakTotalMiB'][0])
    bs = bar(ax, xs, hs, pr, pr, width=w)
    for x, h in zip(xs, hs): ax.text(x, h + 8, f'{h:.0f}', ha='center', va='bottom', fontsize=6.5, color='#333')
ax.set_xticks(range(len(pol))); ax.set_xticklabels(names, fontsize=8); ax.set_ylabel('Peak memory (MiB)')
ax.legend(frameon=False, ncol=3, loc='upper left'); ax.set_ylim(0, 900)
ax.text(0, 30, 'mixedC2: n/a', ha='center', fontsize=6, rotation=90, color='#555')
ax.set_title('Cloud (CLOUD-HL-1T): peak WASM + waiting hidden states, early exit off, n = 5 (identical in all reps)', fontsize=8)
save(fig, 'C1_cloud_peak_memory_by_policy')

# C2 cache speed-up cold/revisit vs link, cloud E5
e5 = A['E5']; links = [('unthrottled', 'localhost'), ('50', '50 Mbit/s'), ('20', '20 Mbit/s'), ('10', '10 Mbit/s'), ('5', '5 Mbit/s')]
fig, ax = plt.subplots(figsize=(6.0, 3.2)); mk = {'int8': 'o', 'mixedC2': 's', 'fp32': '^'}; ls = {'int8': '-', 'mixedC2': '--', 'fp32': ':'}
for pr in ['int8', 'mixedC2', 'fp32']:
    xs, ys, lo, hi = [], [], [], []
    for i, (k, _) in enumerate(links):
        c = e5.get(f'{k}|{pr}')
        if not isinstance(c, dict) or c.get('speedup') is None: continue
        xs.append(i); ys.append(c['speedup']); lo.append(c['speedup'] - c['speedupCI95'][0]); hi.append(c['speedupCI95'][1] - c['speedup'])
    ax.errorbar(xs, ys, yerr=[lo, hi], color=COL[pr], marker=mk[pr], ls=ls[pr], lw=1.6, ms=5, capsize=2, label=pr)
    ax.annotate(f'×{ys[-1]:.0f}', (xs[-1], ys[-1]), textcoords='offset points', xytext=(6, -2), fontsize=7)
ax.set_yscale('log'); ax.set_yticks([1, 2, 5, 10, 20, 50, 100]); ax.set_yticklabels(['×1', '×2', '×5', '×10', '×20', '×50', '×100']); ax.set_xticks(range(len(links))); ax.set_xticklabels([l for _, l in links])
ax.set_ylabel('TTFI speed-up, cold ÷ revisit (log)'); ax.legend(frameon=False)
ax.set_title('Cloud (CLOUD-HL-1T-NET-*): cache revisit speed-up, median [95% CI]; fp32 at 5 Mbit/s omitted', fontsize=8)
save(fig, 'C2_cloud_cache_speedup_by_link')

# C3 early exit latency: cloud and Mac as separate figures
def ee_fig(rows, title, name):
    fig, ax = plt.subplots(figsize=(6.4, 3.0)); w = 0.38
    for i, (lab, off, on) in enumerate(rows):
        bar(ax, [i - w / 2], [off], 'off', 'early exit off' if i == 0 else None, width=w)
        bar(ax, [i + w / 2], [on], 'on', 'early exit on (τ = 0.95)' if i == 0 else None, width=w)
        ax.text(i + w / 2, on + 2, f'{100 * (on - off) / off:+.1f}%', ha='center', fontsize=7)
    ax.set_xticks(range(len(rows))); ax.set_xticklabels([r[0] for r in rows], fontsize=7.5)
    ax.set_ylabel('M4 latency (ms)'); ax.legend(frameon=False, loc='upper left'); ax.set_title(title, fontsize=8); save(fig, name)
E3 = A['E3latency']; rows = []
for p, lab in [('resident', 'resident'), ('sequential', 'sequential G32\n(amortised)')]:
    for pr in ['int8', 'mixedC2', 'fp32']:
        c = E3.get(f'{p}|{pr}')
        if c: rows.append((f'{lab}\n{pr}', c['off']['median'], c['on']['median']))
ee_fig(rows, 'Cloud (CLOUD-HL-1T): M4 median, n = 5; every on − off CI excludes 0', 'C3a_cloud_early_exit_latency')
m3 = M['MAC3']['table']; rows = []
for p, lab in [('resident', 'resident'), ('sequential', 'sequential G32\n(amortised)')]:
    for pr in ['int8', 'mixedC2']:
        a0, a1 = m3.get(f'{p}|{pr}|ee0'), m3.get(f'{p}|{pr}|ee1')
        if a0 and a1: rows.append((f'{lab}\n{pr}', a0['m4']['median'], a1['m4']['median']))
ee_fig(rows, 'Mac (MAC-CHROME-*, MAC-3 re-run): M4 median, n = 5; every on − off CI excludes 0', 'C3b_mac_early_exit_latency')

# C4/C6 engine time-prediction error by plan shape: cloud and Mac separately
shapes = ['resident', 'sequential', 'sequential+pre-start', 'hybrid', 'hybrid+pre-start']
def err_fig(d, title, name, ylim):
    fig, ax = plt.subplots(figsize=(6.4, 3.2)); w = 0.38
    for j, cache in enumerate(['warm', 'cold']):
        for i, s in enumerate(shapes):
            c = d.get(f'{s}|{cache}')
            if not c: continue
            x = i + (j - 0.5) * w; m = c['median']
            bar(ax, [x], [m], cache, cache if i == 0 else None, width=w,
                yerr=[[m - c['ci95'][0]], [c['ci95'][1] - m]], error_kw={'ecolor': '#333', 'capsize': 2, 'lw': 0.8})
            ax.text(x, (c['ci95'][1] + 2) if m >= 0 else (c['ci95'][0] - 2), f'{m:+.0f}%', ha='center', va='bottom' if m >= 0 else 'top', fontsize=6.5)
    ax.axhline(0, color='#333', lw=0.8); ax.set_xticks(range(len(shapes))); ax.set_xticklabels([s.replace('+', ' +\n') for s in shapes], fontsize=7.5)
    ax.set_ylabel('Prediction error (%)\n(negative = optimistic)'); ax.set_ylim(*ylim); ax.legend(frameon=False, loc='upper right'); ax.set_title(title, fontsize=8); save(fig, name)
err_fig(A['ENG']['timeErrorByShapeAndCache'], 'Cloud (CLOUD-HL-1T, E-ENG): median [95% CI], 200 runs', 'C4_cloud_engine_time_error', (-65, 45))
err_fig(M['MAC2']['timeErrorByShape'], 'Mac (MAC-2 re-run): median [95% CI], 180 runs', 'C6_mac_engine_time_error', (-50, 140))

# C5 Mac thread sweep MAC-1
m1 = M['MAC1']['table']; th = [1, 2, 4, 8]
fig, ax = plt.subplots(figsize=(5.6, 3.0))
for pr in ['int8', 'fp32']:
    ys = [m1[f'{pr}|T{n}']['m4']['median'] for n in th]; ci = [m1[f'{pr}|T{n}']['m4']['ci95'] for n in th]
    ax.errorbar(th, ys, yerr=[[y - c[0] for y, c in zip(ys, ci)], [c[1] - y for y, c in zip(ys, ci)]], color=COL[pr],
                marker='o' if pr == 'int8' else '^', ls='-' if pr == 'int8' else ':', lw=1.6, ms=5, capsize=2, label=pr)
ax.set_xscale('log', base=2); ax.set_xticks(th); ax.set_xticklabels([str(n) for n in th]); ax.set_xlabel('ORT page threads')
ax.set_ylabel('M4 single-request latency (ms)'); ax.legend(frameon=False)
ax.set_title('Mac (MAC-CHROME-T1/T2/T4/T8, MAC-1): baseline, median [95% CI], n = 5', fontsize=8)
save(fig, 'C5_mac_thread_sweep')
print('charts:', ', '.join(log))
