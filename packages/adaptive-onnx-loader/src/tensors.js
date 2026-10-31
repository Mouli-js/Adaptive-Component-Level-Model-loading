/**
 * Plain-object tensor format used across chunk boundaries and Worker messages:
 *   { type: 'float32' | 'int64', data: TypedArray, dims: number[] }
 * It is structured-clone friendly, and its `data.buffer` can be put in a postMessage
 * transfer list, so 1–2 MB hidden-state tensors move between Workers without copying.
 */
export function toOrt(ort, t) { return new ort.Tensor(t.type, t.data, t.dims); }

/** ORT output tensor -> plain tensor whose buffer we own (transferable). */
export function fromOrt(t) {
  let data = t.data;
  // A view on WASM (Shared)ArrayBuffer memory can't be transferred and would be overwritten
  // by the next run, so copy unless we own a standalone ArrayBuffer of exactly this size.
  if (!(data.buffer instanceof ArrayBuffer) || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
  return { type: t.type, data, dims: Array.from(t.dims) };
}

export function transferList(tensors) { return Object.values(tensors).map(t => t.data.buffer); }

/** Slice rows [start, end) of the batch dimension (dims[0]); returns a copy. */
export function sliceBatch(t, start, end) {
  const per = t.dims.slice(1).reduce((a, b) => a * b, 1);
  return { type: t.type, data: t.data.slice(start * per, end * per), dims: [end - start, ...t.dims.slice(1)] };
}
