"""D9 schematic: which chunk Workers are alive over time for each execution policy (NOT measured data, not to scale).
Semantics follow workers/planRunner.js classifyMany(): spawn on first use, run the group, terminate if not pinned;
pre-start spawns the next non-pinned chunk while the current one computes."""
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt, os
plt.rcParams.update({'font.family': 'DejaVu Serif', 'font.size': 8.5})
CH = ['C0', 'C1', 'C2', 'C3']; LOAD, RUN = '#9ca3af', '#2a78d6'
def seq(prestart=False, pinned=()):
    ev, t = [], 0.0
    for g in range(2):                      # two groups of sentences
        for i, c in enumerate(CH):
            if c in pinned and g > 0:        # pinned Worker already alive: compute only
                ev.append((c, t, 0, 1.0)); t += 1.0; continue
            load = 0 if (prestart and i > 0 and c not in pinned) else 1.2
            ev.append((c, t, load, 1.0))
            if prestart and i + 1 < 4 and CH[i + 1] not in pinned and not (g > 0 and CH[i + 1] in pinned):
                ev.append((CH[i + 1], t + load, 1.2, 0, 'pre'))
            t += load + 1.0
    return ev, t
pol = [('Resident (all pinned, G = 1: sentence-major)', dict(pinned=tuple(CH))), ('Sequential (nothing pinned)', dict()), ('Sequential + pre-start', dict(prestart=True)), ('Hybrid (C0 pinned)', dict(pinned=('C0',)))]
fig, axes = plt.subplots(len(pol), 1, figsize=(6.6, 6.2), sharex=False)
for ax, (title, kw) in zip(axes, pol):
    if kw is None:
        t = 0
        for i, c in enumerate(CH): ax.broken_barh([(t, 1.2)], (i - .35, .7), color=LOAD); t += 1.2
        for g in range(2):
            for i, c in enumerate(CH): ax.broken_barh([(t, 1.0)], (i - .35, .7), color=RUN); t += 1.0
        for i in range(4): ax.plot([0.0 + 1.2 * (i + 1), t], [i, i], color='#111', lw=0.6, ls=':')
        end = t
    else:
        ev, end = seq(**kw); alive = {}
        for e in ev:
            c, s, l, r = e[:4]; i = CH.index(c)
            if len(e) == 5: ax.broken_barh([(s, l)], (i - .35, .7), color=LOAD, hatch='////', edgecolor='white'); continue
            if l: ax.broken_barh([(s, l)], (i - .35, .7), color=LOAD)
            ax.broken_barh([(s + l, r)], (i - .35, .7), color=RUN)
        if kw.get('pinned'):
            ax.plot([1.2, end], [0, 0], color='#111', lw=0.6, ls=':')
    ax.set_yticks(range(4)); ax.set_yticklabels(CH); ax.invert_yaxis(); ax.set_xticks([]); ax.set_xlim(0, max(end, 1) + .3)
    ax.set_title(title, fontsize=9, loc='left'); [s.set_visible(False) for s in (ax.spines['top'], ax.spines['right'])]
from matplotlib.patches import Patch
from matplotlib.lines import Line2D
fig.legend(handles=[Patch(color=LOAD, label='Worker start + session creation'), Patch(facecolor=LOAD, hatch='////', edgecolor='white', label='pre-started during previous chunk'),
                    Patch(color=RUN, label='compute (group of sentences)'), Line2D([], [], color='#111', ls=':', lw=0.8, label='Worker kept alive (pinned)')],
           loc='lower center', ncol=2, frameon=False, fontsize=8)
fig.text(0.5, 0.005, 'Schematic, not to scale and not measured data: two consecutive groups; gaps = Worker terminated.', ha='center', fontsize=7.5, style='italic')
fig.tight_layout(rect=(0, 0.08, 1, 1)); fig.savefig(os.path.join(os.path.dirname(__file__), '..', 'D9_policies.png'), dpi=220)
