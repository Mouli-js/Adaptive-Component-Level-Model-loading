/** Re-derive the full E-ENG decision traces (every candidate's predicted cost and terms) with the SAME calibration
 *  file and the same cache states. Decision-only: no measurement. Asserts the chosen plans equal decisions.json. */
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, startServer, newProfile, openRunner } from './lib.mjs';
const DIR = path.join(ROOT, 'results/phase7/eng');
const calibration = JSON.parse(fs.readFileSync(path.join(DIR, 'calibration_cloud.json')));
const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'decisions.json')));
const server = await startServer({}); const master = '/home/claude/p7profiles/eng';
const out = [];
for (const cache of ['cold', 'warm']) {
  const d0 = cache === 'warm' ? (() => { const d = newProfile('engt'); fs.cpSync(master, d, { recursive: true }); for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) fs.rmSync(path.join(d, f), { force: true }); return d; })() : newProfile('engt');
  const { ctx, page } = await openRunner(d0, server.base);
  for (const profile of ['low', 'mid', 'high']) for (const earlyExit of [false, true]) {
    const d = await page.evaluate(a => window.p7.decide(a), { profile, overrides: { sentencesPerRequest: 20, earlyExit }, calibration });
    const s = saved.find(x => x.cache === cache && x.link === 'localhost' && x.profile === profile && x.earlyExit === earlyExit);
    if (s.chosen !== d.plan.id) throw new Error(`not reproducible: ${cache} ${profile} ${earlyExit}`);
    out.push({ cache, profile, earlyExit, chosen: d.plan.id, weights: d.signals ? undefined : undefined, trace: d.trace.filter(t => t.status !== 'rejected') });
  }
  await ctx.close(); fs.rmSync(d0, { recursive: true, force: true });
}
server.close();
fs.writeFileSync(path.join(DIR, 'decision_traces.json'), JSON.stringify(out));
console.log('reproduced', out.length, 'decisions; all chosen plans identical to decisions.json');
