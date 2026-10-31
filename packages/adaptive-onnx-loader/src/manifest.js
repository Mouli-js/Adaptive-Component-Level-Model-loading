/** Helpers around models/onnx/manifest.json (the Python-build ↔ runtime contract). */
export async function loadManifest(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`manifest ${url}: HTTP ${res.status}`);
  const m = await res.json();
  m.baseUrl = new URL('.', new URL(url, globalThis.location?.href ?? 'file:///')).href;
  return m;
}

/**
 * Normalise a precision spec into a per-chunk map.
 *   'int8'                        -> every chunk int8
 *   { c2_l2_3: 'fp32' } + default -> listed chunks overridden
 */
export function precisionPlan(manifest, spec = 'int8', fallback = 'int8') {
  const plan = {};
  for (const name of manifest.chain) plan[name] = typeof spec === 'string' ? spec : (spec[name] ?? fallback);
  return plan;
}

export function chunkEntry(manifest, name, precision) {
  const e = manifest.chunks[name]?.[precision] ?? manifest.exits?.[name]?.[precision];
  if (!e) throw new Error(`no ${precision} artifact for ${name}`);
  return { name, precision, url: new URL(e.file, manifest.baseUrl).href, ...e };
}
