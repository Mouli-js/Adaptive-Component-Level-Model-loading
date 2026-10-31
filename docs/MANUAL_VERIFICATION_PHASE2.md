# Phase 2 — Manual Browser Verification on macOS

**Purpose:** Confirm on your own Mac, in your own Chrome, that the baseline page behaves the way the automated cloud test showed. This is the gate before the Phase 2 commit.
**Time:** about 10 minutes · **You need:** Google Chrome, macOS Terminal, Node.js 18 or newer.

> Why this is manual: my sandbox on your Mac can't run a browser, so the automated tests ran in headless Chromium in the cloud (x86, 2 vCPU). This check proves the system works on the real target: a normal desktop browser on Apple Silicon.

---

## Step 0: Prerequisites (one-time)

In **macOS Terminal** (not inside Claude):

```bash
node -v
```

- If it prints `v18.x` or higher, continue.
- If it says `command not found`, install Node: `brew install node`, or use the macOS installer from nodejs.org. Then run `node -v` again.

Check the project files are in place:

```bash
cd ~/"Project - 1"
ls models/onnx/fp32/full.onnx models/onnx/int8/full.onnx data/sst2/validation.json data/sst2/wasm_int8_logits_all.json node_modules/onnxruntime-web/package.json
```

All five paths should be listed. If `node_modules/...` is missing, run `npm install`.

*Why this works on macOS even though `node_modules` was installed by the Linux sandbox:* onnxruntime-web is plain JavaScript plus `.wasm` files, with no native binaries, so the same files run on any operating system.

## Step 1: Start the server

```bash
cd ~/"Project - 1"
npm run serve
```

**Expected output:**

```
serving /Users/mouli-19544/Project - 1
  http://localhost:8080/demo/phase2-baseline.html
```

Leave this Terminal window open; closing it stops the server. If port 8080 is already in use, run `node demo/server.mjs 8081` and use `8081` in the URLs below.

## Step 2: Open the page and check isolation

In **Chrome**, open: **http://localhost:8080/demo/phase2-baseline.html**

| Check | Expected |
|---|---|
| **A1** | The subtitle says **Cross-origin isolated: yes** (in green) |

If it says **NO**, see Troubleshooting. Stop there, because threads and the memory API won't work.

## Step 3: Test 1, int8 with 4 threads

1. Set **Precision = int8** and **Threads = 4**. Leave **Measure page memory (slow)** unticked.
2. Click **Load model**.

   | Check | Expected |
   |---|---|
   | **B1** | The line next to the button shows `64.2 MiB · fetch … ms · session … ms · WASM heap ~180 MiB`. Loading takes about 1 s. |
   | **B2** | The Threads box becomes disabled and shows *(fixed until page reload)* |

3. Click **Classify** with the default sentence *"a gorgeous, witty, seductive movie."*

   | Check | Expected |
   |---|---|
   | **B3** | **POSITIVE** with high confidence. The token line reads `[CLS] a gorgeous , witty , seductive movie . [SEP]` |

4. Replace the text with *the plot is dull and the acting is worse.* and click **Classify**.

   | Check | Expected |
   |---|---|
   | **B4** | **NEGATIVE** |

5. Click **Run SST-2 validation (872 sentences)** and wait. It should take about 20–60 s; the counter next to the button shows progress.

   | Check | JSON field | Expected |
   |---|---|---|
   | **B5** | `tokenizerMismatches` | `0` |
   | **B6** | `accuracy` | `0.9002293577981652` |
   | **B7** | `agreementWithReference` | `1` |
   | **B8** | `maxAbsLogitDiffVsReference` | `0` (any value below 0.001 is a pass) |
   | **B9** | `agreementWithNativeInt8` | `0.9988532110091743` (the documented 1-sentence native-vs-WASM difference, D-2.1) |
   | **B10** | `memLoaded.wasmHeapBytes` vs `memReleased.wasmHeapBytes` | **Equal**, both about 189,000,000. This shows the WASM heap does not shrink after `release()`. |

6. Click **Copy results** and paste the JSON into a text file named `mac_int8_4t.json` (or straight into the chat).

## Step 4: Test 2, fp32 with 4 threads

1. **Reload the page** (⌘R). This is required: the thread count and the WASM heap are fixed per page.
2. Set **Precision = fp32**, **Threads = 4**, then click **Load model**.

   | Check | Expected |
   |---|---|
   | **C1** | `255.5 MiB · … · WASM heap ~656 MiB`. Loading takes about 1–3 s. |

3. Click **Run SST-2 validation**.

   | Check | JSON field | Expected |
   |---|---|---|
   | **C2** | `tokenizerMismatches` | `0` |
   | **C3** | `accuracy` | `0.9105504587155964` |
   | **C4** | `agreementWithReference` | `1` |
   | **C5** | `maxAbsLogitDiffVsReference` | below `0.001` (the cloud run gave about 2.6e-5) |
   | **C6** | `memLoaded.wasmHeapBytes` = `memReleased.wasmHeapBytes` | equal, about 688,000,000 |

4. **Copy results** → `mac_fp32_4t.json`.

## Step 5 (optional, about 3 min): see the memory problem with your own eyes

1. In Chrome open **⋮ → More tools → Task manager**.
2. Reload the page, load **fp32**, and watch this tab's **Memory footprint** jump by about 650–700 MB.
3. Run the validation. When it finishes, the page has called `release()`, but the footprint does **not** go down.

This is exactly the behaviour Phase 3 fixes with one Worker per chunk.

## Step 6 (optional): page-memory API on a real Chrome

Reload, tick **Measure page memory (slow)**, choose int8 / 1 thread, load, then run the validation. Expect it to take minutes longer; that slowness is the finding being confirmed. Then check that `memLoaded.uaBytes` is about `wasmHeapBytes` + 5 MB.

## Step 7: Stop the server

Press **Ctrl+C** in the Terminal window.

---

## Pass criteria

Phase 2 manual verification **passes** if **A1, B1–B10 and C1–C6** all match. Please send me:

1. The two JSON results (`mac_int8_4t.json`, `mac_fp32_4t.json`). I'll save them as `results/phase2/mac_*.json` and add the Mac numbers to the report.
2. Your Chrome version (⋮ → Help → About Google Chrome).
3. Your Mac model, chip and memory (Apple menu → About This Mac).
4. Anything that didn't match, with a screenshot if possible.

The timings (load, latency) will differ from the cloud numbers; that's expected. Only the correctness fields (B5–B9, C2–C5) must match exactly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Cross-origin isolated: NO" | The page was opened as a file (`file://…`), through another server, or an extension removed the headers | Use exactly `http://localhost:8080/...` from `npm run serve`; try a guest window with no extensions |
| `EADDRINUSE` when starting the server | Port 8080 is taken | `node demo/server.mjs 8081` |
| "threads already fixed at N" | You changed Threads after loading | Reload the page (⌘R) |
| A 404 error in the page or the DevTools console for `/data/sst2/...json` | Fixtures missing | Tell me; I regenerate them with `python/export_browser_fixtures.py` |
| Very slow, or the tab is killed with fp32 | Low free memory (fp32 needs about 700 MB) | Close other tabs; int8 alone is enough to pass B-checks |
| The run seems stuck with "Measure page memory" ticked | Expected: Chrome waits for garbage collection | Untick it for the main tests |
| Safari or Firefox | `measureUserAgentSpecificMemory` and `performance.memory` are Chromium-only | Use Chrome for this check |
