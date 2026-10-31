"""Phase 2 — Python reference IDs for tokenizer edge cases -> packages/adaptive-onnx-loader/test/fixtures/tokenizer_edge_cases.json
(tracked in git: tiny, hand-written inputs, no dataset content)."""
import json
from adaptive_split import load_tokenizer
from adaptive_split.load import ROOT

CASES = [
    "", "   ", "Hello, World!", "I LOVE this movie!!!", "don't won't can't", "amélie Æsir naïve café",
    "Straße ﬁne", "İstanbul", "中文字符测试", "mixed 中文 and english", "emoji 😀👍 test", "tabs\tand\nnewlines\r\n",
    "zero​width", "nul\u0000char", "soft­hyphen", "replacement�char", "a" * 150, "supercalifragilisticexpialidocious",
    "price is $100.50 ^_^ `code` ~tilde~ {brace}", "e-mail: test@example.com #hashtag", "— en–dash “quotes” ‘single’ …",
    "x" * 99 + " " + "y" * 101, "the " * 200, "unaffable unbelievable", "١٢٣ arabic digits", "ｆｕｌｌｗｉｄｔｈ",
]

def main():
    tok = load_tokenizer()
    out = [{"text": t, "ids": tok(t, truncation=True, max_length=128)["input_ids"]} for t in CASES]
    p = ROOT / "packages/adaptive-onnx-loader/test/fixtures"; p.mkdir(parents=True, exist_ok=True)
    (p / "tokenizer_edge_cases.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for o in out[:12]: print(repr(o["text"][:40]), tok.convert_ids_to_tokens(o["ids"])[:12])

if __name__ == "__main__":
    main()
