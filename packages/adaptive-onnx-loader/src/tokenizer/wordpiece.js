/**
 * BERT WordPiece tokenizer (uncased) — a dependency-free re-implementation of the
 * Hugging Face `BertTokenizerFast` pipeline used to train/evaluate DistilBERT.
 *
 * Pipeline (same order as HF `tokenizers` BertNormalizer + BertPreTokenizer + WordPiece):
 *   1. clean      : drop NUL / U+FFFD / control chars, map every whitespace char to ' '
 *   2. CJK        : put spaces around CJK ideographs (each becomes its own word)
 *   3. accents    : Unicode NFD, then remove combining marks (é -> e)
 *   4. lowercase
 *   5. pre-split  : split on whitespace, and make every punctuation char its own token
 *   6. WordPiece  : greedy longest-match-first against the vocab; continuation pieces
 *                   are prefixed "##"; a word with no full segmentation -> [UNK]
 *   7. specials   : [CLS] tokens… [SEP], truncated to maxLength
 *
 * Works in browsers and Node (no DOM / fs access inside the class).
 */

const RE_WS = /^[\t\n\r]$|^\p{Zs}$/u;          // whitespace per BERT
const RE_CTRL = /^\p{C}$/u;                     // control/format chars (Cc, Cf, Co, Cn, Cs)
const RE_PUNCT_UNI = /^\p{P}$/u;
const RE_MARK = /\p{Mn}/gu;                     // non-spacing combining marks

function isPunct(cp) {
  // BERT treats all non-alphanumeric ASCII as punctuation (e.g. ^ $ ` are not Unicode P)
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return RE_PUNCT_UNI.test(String.fromCodePoint(cp));
}

function isCJK(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) ||
         (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
         (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

export class WordPieceTokenizer {
  /**
   * @param {string[]} vocabList  one token per line of vocab.txt (line index = token id)
   * @param {object} [opts]
   */
  constructor(vocabList, opts = {}) {
    this.vocab = new Map(vocabList.map((t, i) => [t, i]));
    this.idToToken = vocabList;
    this.unk = opts.unkToken ?? '[UNK]';
    this.cls = opts.clsToken ?? '[CLS]';
    this.sep = opts.sepToken ?? '[SEP]';
    this.pad = opts.padToken ?? '[PAD]';
    this.maxInputCharsPerWord = opts.maxInputCharsPerWord ?? 100;
    this.maxLength = opts.maxLength ?? 128;
    for (const t of [this.unk, this.cls, this.sep, this.pad])
      if (!this.vocab.has(t)) throw new Error(`special token ${t} missing from vocab`);
  }

  /** Build from the raw text of vocab.txt */
  static fromVocabText(text, opts) {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();        // trailing newline
    return new WordPieceTokenizer(lines.map(l => l.replace(/\r$/, '')), opts);
  }

  /** Steps 1–4: text -> normalized text */
  normalize(text) {
    let out = '';
    for (const ch of text) {                      // iterates by code point, not UTF-16 unit
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xFFFD) continue;
      if (RE_WS.test(ch)) { out += ' '; continue; }
      if (RE_CTRL.test(ch)) continue;
      out += isCJK(cp) ? ` ${ch} ` : ch;
    }
    return out.normalize('NFD').replace(RE_MARK, '').toLowerCase();
  }

  /** Step 5: normalized text -> words (punctuation split out) */
  preTokenize(text) {
    const words = [];
    for (const chunk of text.split(' ')) {
      if (!chunk) continue;
      let cur = '';
      for (const ch of chunk) {
        if (isPunct(ch.codePointAt(0))) { if (cur) words.push(cur); words.push(ch); cur = ''; }
        else cur += ch;
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  /** Step 6: one word -> WordPiece tokens */
  wordPiece(word) {
    const chars = Array.from(word);
    if (chars.length > this.maxInputCharsPerWord) return [this.unk];
    const pieces = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found = null;
      while (start < end) {                       // longest match first
        let sub = chars.slice(start, end).join('');
        if (start > 0) sub = '##' + sub;
        if (this.vocab.has(sub)) { found = sub; break; }
        end--;
      }
      if (found === null) return [this.unk];      // HF behaviour: whole word becomes [UNK]
      pieces.push(found);
      start = end;
    }
    return pieces;
  }

  tokenize(text) {
    return this.preTokenize(this.normalize(text)).flatMap(w => this.wordPiece(w));
  }

  /** Step 7: text -> ids with [CLS]/[SEP], truncated to maxLength */
  encode(text, maxLength = this.maxLength) {
    const ids = this.tokenize(text).map(t => this.vocab.get(t));
    return [this.vocab.get(this.cls), ...ids.slice(0, maxLength - 2), this.vocab.get(this.sep)];
  }

  /**
   * Batch encode with right-padding to the longest sequence.
   * Returns flat BigInt64Arrays ready for ort.Tensor('int64', data, [batch, seq]).
   */
  encodeBatch(texts, maxLength = this.maxLength) {
    const enc = texts.map(t => this.encode(t, maxLength));
    const seq = Math.max(...enc.map(e => e.length));
    const inputIds = new BigInt64Array(texts.length * seq);      // zero-filled = [PAD] id 0
    const attentionMask = new BigInt64Array(texts.length * seq);
    const padId = BigInt(this.vocab.get(this.pad));
    enc.forEach((ids, b) => {
      for (let i = 0; i < seq; i++) {
        inputIds[b * seq + i] = i < ids.length ? BigInt(ids[i]) : padId;
        attentionMask[b * seq + i] = i < ids.length ? 1n : 0n;
      }
    });
    return { inputIds, attentionMask, dims: [texts.length, seq], lengths: enc.map(e => e.length) };
  }

  decode(ids) { return ids.map(i => this.idToToken[i]); }
}
