/**
 * Chaining rule shared by every runner (main thread or Workers):
 *   c0_embed   : { input_ids }                      -> { hidden }
 *   c1, c2, c3 : { hidden_in, attention_mask }      -> { hidden } | { logits }
 * i.e. the previous chunk's `hidden` output becomes the next chunk's `hidden_in`.
 */
export function feedsFor(chunkName, index, state) {
  if (index === 0) return { input_ids: state.input_ids };
  return { hidden_in: state.hidden, attention_mask: state.attention_mask };
}

export function encodeToTensors(tokenizer, texts) {
  const e = tokenizer.encodeBatch(texts);
  return { input_ids: { type: 'int64', data: e.inputIds, dims: e.dims },
           attention_mask: { type: 'int64', data: e.attentionMask, dims: e.dims } };
}

export function logitsRows(t) {
  const rows = [], k = t.dims[1];
  for (let i = 0; i < t.dims[0]; i++) rows.push(Array.from(t.data.slice(i * k, (i + 1) * k)));
  return rows;
}
