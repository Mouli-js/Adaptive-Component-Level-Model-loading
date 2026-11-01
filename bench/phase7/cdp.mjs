/**
 * Minimal raw CDP client (Node 22 global WebSocket, flatten sessions). Used only for CPU throttling,
 * because Playwright's CDPSession cannot address dedicated-Worker targets.
 * Chromium is launched with --remote-debugging-port=0; the port is read from <profile>/DevToolsActivePort.
 */
import fs from 'node:fs'; import path from 'node:path';

export async function connectCDP(profileDir) {
  let port = null;
  for (let k = 0; k < 50 && !port; k++) {
    try { port = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res } = pending.get(m.id); pending.delete(m.id); res(m); }
    else listeners.forEach(f => f(m));
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, { res }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { send, on: f => listeners.push(f), close: () => ws.close() };
}

/**
 * Apply CPU throttling. scope: 'page' (page target only) | 'workers' (every dedicated Worker, incl. ones
 * created later) | 'both'. Returns a log of every setCPUThrottlingRate result so failures are visible.
 */
export async function throttleCPU(cdp, pageUrlPart, rate, scope) {
  const log = [];
  const { result } = await cdp.send('Target.getTargets');
  const pageT = result.targetInfos.find(t => t.type === 'page' && t.url.includes(pageUrlPart));
  if (!pageT) throw new Error('page target not found');
  const { result: { sessionId: ps } } = await cdp.send('Target.attachToTarget', { targetId: pageT.targetId, flatten: true });
  if (scope === 'page' || scope === 'both') { const r = await cdp.send('Emulation.setCPUThrottlingRate', { rate }, ps); log.push({ target: 'page', ok: !r.error, error: r.error?.message }); }
  if (scope === 'workers' || scope === 'both') {
    cdp.on(async m => {
      if (m.method !== 'Target.attachedToTarget' || m.params.targetInfo.type !== 'worker') return;
      const s = m.params.sessionId;
      const r = await cdp.send('Emulation.setCPUThrottlingRate', { rate }, s);
      log.push({ target: 'worker', url: m.params.targetInfo.url, ok: !r.error, error: r.error?.message });
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, s);
    });
    const r = await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, ps);
    log.push({ target: 'autoAttach', ok: !r.error, error: r.error?.message });
  }
  return log;
}
