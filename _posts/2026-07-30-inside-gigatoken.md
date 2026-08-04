---
layout: post
title: "Inside Gigatoken: Optimisations Beyond 'Rewrite It in Rust'"
date: 2026-07-30
description: "A first-principles tour of the SIMD scanners, cache-aware layouts, huge pages and worker scheduling behind Gigatoken."
tags: [ai, performance, tokenization, systems]
image: /assets/images/gigatoken-engine-teardown-cover-clean.webp
---

The AI industry pours engineering effort into GPU kernels and treats CPU preprocessing as an afterthought. Gigatoken shows how much performance that neglect can leave on the table.

In my [first Gigatoken post](/gigatoken-thousand-times-faster/), I tested its 1,000x claim against my tokenizer workload. On that workload, the tokenizer core ran **30x to 40x** faster, including **37.6x** on a million-token request split into 1,024 segments. The result was well below 1,000x. I wanted to understand where the gain came from.

I followed the path Gigatoken optimises most aggressively: tokenizers that apply BPE (byte pair encoding) to UTF-8 bytes, including GPT-2 and the tiktoken family. This is the path behind its headline throughput and the one exercised by my benchmark. The project has no technical paper yet, so what follows is my interpretation of Marcel Rød's source comments, optimisation diary, profiling reports and commit history.[^source] Gigatoken describes SentencePiece as less optimised and does not support WordPiece.[^scope]

## How BPE turns bytes into tokens

The tokenizers in this article turn UTF-8 text into a sequence of integers. Their vocabularies map byte sequences to token IDs. A token might represent a whole word, part of a word, punctuation or a single byte.

Encoding runs as a pipeline. *Pretokenisation* is the coarse split immediately before BPE: it divides the continuous byte stream into spans using model-specific rules, commonly expressed as a regular expression. Each intermediate span is a *pretoken*, which BPE consumes to produce the final model tokens. For a GPT-2-style tokenizer:

```text
" token 42!"  →  [" token", " 42", "!"]
```

<figure style="width:100%;max-width:calc(100vw - 3rem);margin:2.5rem 0;overflow-x:auto;">
<svg id="bpe-pipeline" viewBox="0 0 860 260" width="100%" style="height:auto;min-width:700px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-labelledby="bpe-pipeline-title bpe-pipeline-desc">
<title id="bpe-pipeline-title">How BPE turns bytes into token IDs</title>
<desc id="bpe-pipeline-desc">UTF-8 bytes are split into independent pretokens. Each pretoken passes through repeated byte-pair merges before the remaining vocabulary entries become token IDs.</desc>
<defs><marker id="arrow-pipeline" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#b87a18"/></marker></defs>
<rect x="20" y="42" width="150" height="76" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="95" y="72" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">UTF-8 bytes</text>
<text x="95" y="96" text-anchor="middle" fill="#8a7f70" font-size="13">input text</text>
<path d="M170 80 H220" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-pipeline)"/>
<rect x="225" y="42" width="170" height="76" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="310" y="72" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">Pretokenise</text>
<text x="310" y="96" text-anchor="middle" fill="#8a7f70" font-size="13">find model-defined spans</text>
<path d="M395 80 H445" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-pipeline)"/>
<rect x="450" y="25" width="180" height="110" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="540" y="54" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">BPE within each span</text>
<text x="540" y="82" text-anchor="middle" fill="#8a7f70" font-size="13">[l] [o] [w] [e] [r]</text>
<text x="540" y="108" text-anchor="middle" fill="#b87a18" font-size="13">[lo] [w] [e] [r]</text>
<path d="M630 80 H680" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-pipeline)"/>
<rect x="685" y="42" width="155" height="76" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="762" y="72" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">Token IDs</text>
<text x="762" y="96" text-anchor="middle" fill="#8a7f70" font-size="13">vocabulary entries</text>
<rect x="225" y="174" width="405" height="54" rx="9" fill="#fffaf1" stroke="#bf9a5a" stroke-width="2" stroke-dasharray="6 5"/>
<text x="427" y="198" text-anchor="middle" fill="#2c2825" font-size="14">Across pretokens: independent</text>
<text x="427" y="217" text-anchor="middle" fill="#8a7f70" font-size="12">Within one: each merge changes the next choice</text>
</svg>
<figcaption style="margin-top:0.75rem;color:#8a7f70;font-size:0.85rem;line-height:1.5;">Pretokenisation divides the byte stream into model-defined spans. BPE may merge only within a span, so different spans can be processed independently. Within one span, each merge changes the candidates for the next merge.</figcaption>
</figure>

The hard boundaries also explain why the spans are independent. BPE is forbidden to merge across them, so a merge inside one pretoken cannot create or remove a candidate pair in another. The encoder can process each pretoken separately, then concatenate their token IDs in the original order.

Inside one pretoken, BPE starts from bytes or initial symbols. Its merge table was learned when the tokenizer was trained and is fixed during encoding. Each legal adjacent pair has a numeric rank, and the lower rank wins. If `lo` is the best-ranked adjacent pair, the symbol sequence changes from `[l] [o] [w] [e] [r]` to `[lo] [w] [e] [r]`. The encoder looks up the affected neighbouring pairs again, chooses the next best merge and repeats until no legal merge remains. The surviving symbols map to token IDs.[^bpe]

## What Gigatoken changes inside the Rust core

Traditional Python tokenizer APIs inspect Python input objects and assemble Python-facing results; Gigatoken can read borrowed byte buffers and assemble a flat token buffer in Rust. The service I benchmarked already uses a Rust tokenizer core, so I exclude those API-boundary gains and examine the CPU and memory work inside tokenisation.[^native-api]

I group the Rust-core changes into four families: 64-byte boundary classification, cached pretoken encodings, compact pair-rank tables for misses and parallel work split at safe pretoken boundaries. These are the four main hot-path changes for the BPE tokenizers in scope. The available measurements use different machines, cache states and controls, which prevents a clean apportionment of the overall speed-up. Each result needs its own baseline.

## 1. Pretokenise 64 bytes at a time

A general-purpose regex engine finds one matching span after another. Gigatoken's *mask scanner* asks which positions in a **64-byte input block** begin pretokens. The block sets the scanner's working width. Pretokens can continue across its edges.

The first classification pass handles ASCII, where one byte represents one character and simple byte comparisons can identify letters, digits, spaces, newlines, apostrophes and other categories. SIMD performs these comparisons across several byte positions at once. Each position is called a lane, and each lane holds one byte here. Four 16-byte NEON loads cover the batch on ARM, two 32-byte AVX2 loads cover it on x86, and AVX-512 can load all 64 bytes at once. The comparisons become separate 64-bit class masks, with one bit for each input byte. Bytes at or above `0x80` go to a second Unicode pass.[^scanner]

Gigatoken's loader recognises a fixed set of tokenizer patterns and selects dedicated Rust code for each one. For each mask-scanner family, the implementation expresses the regex's boundary rules as operations over the class masks. The code treats each mask as a row of 64 on/off positions. A shift slides one row left or right so each byte lines up with its neighbour. AND keeps positions where two conditions are true, OR combines alternatives, and NOT selects positions outside a class. SIMD has finished once it creates the masks; ordinary 64-bit integer operations then combine them into boundary bits.

The author's detailed optimisation notes and isolated scanner measurements use GPT-2's r50k pretokenizer, so I use the same worked example here.[^scanner] Under r50k's rules, a leading space can join the letter, number or punctuation run after it. In `·go·42!`, where `·` is a space byte, shifting the letter and digit masks supplies the previous-position relationship for every byte at once. The resulting start bits identify `·go`, `·42` and `!`.

<figure style="width:100%;max-width:calc(100vw - 3rem);margin:2.5rem 0;overflow-x:auto;">
<svg id="gigatoken-mask-scanner" viewBox="0 0 900 620" width="100%" style="height:auto;min-width:700px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-labelledby="gigatoken-mask-title gigatoken-mask-desc">
<title id="gigatoken-mask-title">The common 64-byte mask-scanner path</title>
<desc id="gigatoken-mask-desc">A clean ASCII block passes through SIMD byte comparisons, 64-bit class masks and tokenizer-specific boundary rules. The resulting start-bit mask identifies the pretokens in input order.</desc>
<defs><marker id="arrow-mask" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#b87a18"/></marker></defs>
<rect x="150" y="18" width="600" height="66" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="45" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">64-byte block</text>
<text x="450" y="68" text-anchor="middle" fill="#8a7f70" font-size="13">common ASCII path</text>
<path d="M450 84 V111" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-mask)"/>
<rect x="150" y="115" width="600" height="72" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="144" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">SIMD byte comparisons</text>
<text x="450" y="168" text-anchor="middle" fill="#8a7f70" font-size="13">compare many positions as letters, digits, spaces and other classes</text>
<path d="M450 187 V214" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-mask)"/>
<rect x="150" y="218" width="600" height="72" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="247" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">64-bit class masks</text>
<text x="450" y="271" text-anchor="middle" fill="#8a7f70" font-size="13">one mask per class · bit i describes byte i</text>
<path d="M450 290 V317" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-mask)"/>
<rect x="150" y="321" width="600" height="78" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="350" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">Tokenizer-specific boundary rules in Rust</text>
<text x="450" y="375" text-anchor="middle" fill="#8a7f70" font-size="13">shift masks to align neighbours · combine conditions with AND, OR and NOT</text>
<path d="M450 399 V426" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-mask)"/>
<rect x="110" y="430" width="680" height="100" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="457" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">Pretoken-start mask</text>
<text x="450" y="485" text-anchor="middle" fill="#2c2825" font-size="13" font-family="ui-monospace,'SFMono-Regular',Consolas,monospace">bytes    ·   g   o   ·   4   2   !</text>
<text x="450" y="510" text-anchor="middle" fill="#b87a18" font-size="13" font-family="ui-monospace,'SFMono-Regular',Consolas,monospace">starts   1   0   0   1   0   0   1</text>
<path d="M450 530 V557" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-mask)"/>
<rect x="210" y="561" width="480" height="48" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="591" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Ordered pretokens: [·go] [·42] [!]</text>
</svg>
<figcaption style="margin-top:0.75rem;color:#8a7f70;font-size:0.85rem;line-height:1.5;">Here <code>·</code> is the space byte <code>0x20</code>. The scanner works in 64-byte blocks, with carry and lookahead allowing pretokens to continue across block edges.</figcaption>
</figure>

Bit-parallel regex evaluation and SIMD block classification predate Gigatoken. Its contribution is specialising those techniques for the fixed patterns used by model tokenizers.[^bitparallel]

The mask scanner must reproduce the regex's boundaries. A pretoken can cross a 64-byte edge, so the scanner carries information from the preceding character and looks beyond the right edge where a rule needs it. Each batch returns the starts it can prove. Gigatoken calls any uncertain stretch a *bad zone* and re-derives its boundaries exactly. Invalid UTF-8 can create a bad zone, as can ordinary text whose boundary conditions remain ambiguous at the edge of a block.

Differential tests compare the combined mask and fallback output with the reference across crafted edge cases, 4,000 generated inputs and OpenWebText samples.[^scanner]

### Unicode stays exact

About 21% of batches in OpenWebText, a web-text corpus, contain at least one non-ASCII byte. UTF-8 breaks the ASCII pass's one-byte-per-character assumption: one character can occupy several bytes, and those individual bytes do not reveal whether the character is a letter, number or whitespace. The SIMD pass therefore records their positions in a non-ASCII-byte mask for a second classification pass.

The second pass completes the same 64-position masks. For this r50k path, Gigatoken finds each UTF-8 lead byte, decodes its code point and uses a packed table of about 272 KiB to classify the character as a letter, number, whitespace or other. It stamps that class across every byte of the UTF-8 character, preventing a continuation byte from becoming a false boundary, then adds those results to the masks used by the tokenizer's boundary rules.

Any region the masks cannot settle falls back to Gigatoken's *scalar walker*. The walker uses ordinary integer instructions and advances one span boundary at a time. It also handles CPUs without the required SIMD features, the incomplete tail of a buffer and bad zones such as invalid UTF-8 or ambiguous batch-edge cases. For r50k on the OpenWebText sample, about 0.4% of batches require scalar re-derivation.[^unicode]

<figure style="width:100%;max-width:calc(100vw - 3rem);margin:2.5rem 0;overflow-x:auto;">
<svg id="gigatoken-unicode-path" viewBox="0 0 900 745" width="100%" style="height:auto;min-width:700px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-labelledby="gigatoken-unicode-title gigatoken-unicode-desc">
<title id="gigatoken-unicode-title">How Unicode rejoins the mask path</title>
<desc id="gigatoken-unicode-desc">SIMD creates ASCII class masks and a mask of non-ASCII byte positions. If that second mask is non-empty, Gigatoken decodes UTF-8 code points, looks up their classes and stamps each class across the character's bytes. Updated masks feed the tokenizer's boundary rules. An ordered walker reads proven start bits and uses exact scalar advance only through uncertain gaps.</desc>
<defs><marker id="arrow-unicode" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#b87a18"/></marker></defs>
<rect x="215" y="18" width="470" height="70" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="46" text-anchor="middle" fill="#2c2825" font-size="16" font-weight="650">SIMD byte classification</text>
<text x="450" y="70" text-anchor="middle" fill="#8a7f70" font-size="13">ASCII class masks + non-ASCII-byte mask</text>
<path d="M450 88 V114" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<polygon points="450,118 575,163 450,208 325,163" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="157" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Any byte at or</text>
<text x="450" y="178" text-anchor="middle" fill="#2c2825" font-size="14">above 0x80?</text>
<path d="M325 163 H170 V252" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<text x="239" y="150" text-anchor="middle" fill="#8a7f70" font-size="12">no</text>
<rect x="35" y="256" width="270" height="70" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="170" y="284" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Use the ASCII class masks</text>
<text x="170" y="308" text-anchor="middle" fill="#8a7f70" font-size="12.5">nothing else to classify</text>
<path d="M575 163 H720 V222" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<text x="646" y="150" text-anchor="middle" fill="#8a7f70" font-size="12">yes</text>
<rect x="550" y="226" width="340" height="142" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="720" y="254" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Extend the masks for Unicode</text>
<text x="720" y="281" text-anchor="middle" fill="#8a7f70" font-size="12.5">1. find UTF-8 leads and decode code points</text>
<text x="720" y="307" text-anchor="middle" fill="#8a7f70" font-size="12.5">2. look up each character's packed class</text>
<text x="720" y="333" text-anchor="middle" fill="#8a7f70" font-size="12.5">3. stamp that class across its UTF-8 bytes</text>
<text x="720" y="354" text-anchor="middle" fill="#b87a18" font-size="12">letter · number · whitespace · other</text>
<path d="M170 326 V399 H330" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<path d="M720 368 V399 H570" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<rect x="330" y="374" width="240" height="58" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="409" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Updated class masks</text>
<path d="M450 432 V459" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<rect x="275" y="463" width="350" height="66" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="490" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Tokenizer-specific boundary rules</text>
<text x="450" y="513" text-anchor="middle" fill="#8a7f70" font-size="12.5">operate over all 64 byte positions</text>
<path d="M450 529 V556" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<rect x="250" y="560" width="400" height="66" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="587" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">Batch result</text>
<text x="450" y="610" text-anchor="middle" fill="#8a7f70" font-size="12.5">proven start bits + bad-zone bits</text>
<path d="M450 626 V653" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-unicode)"/>
<rect x="90" y="657" width="720" height="70" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="684" text-anchor="middle" fill="#2c2825" font-size="15" font-weight="650">One ordered boundary walker</text>
<text x="450" y="708" text-anchor="middle" fill="#8a7f70" font-size="12.5">read proven start bits · scalar-advance exactly through any uncertain gap · emit pretoken spans</text>
</svg>
<figcaption style="margin-top:0.75rem;color:#8a7f70;font-size:0.85rem;line-height:1.5;">Non-ASCII bytes receive a second classification pass that updates the masks. The scalar walker handles the remaining bad zones, then continues the same ordered boundary stream.</figcaption>
</figure>

When boundaries are requested one at a time, the scanner finds the lowest set bit with `trailing_zeros` and clears it with `mask &= mask - 1`.[^clear-bit] The hot encode path converts each mask into a flat buffer of boundary offsets, collects up to 256 spans, then processes them in a counted loop. The counted loop reduces data-dependent control flow in boundary discovery and consumption. Cache probes, BPE misses and token emission still carry their own branches and dependent work.

On GPT-2/r50k over a 1 GB OpenWebText sample, the mask scanner reached **2,460 to 2,600 MB/s** against 983 MB/s for Gigatoken's scalar reference, an isolated **2.5x to 2.6x** improvement.[^scanner] That figure covers boundary detection. Turning each span into token IDs remains downstream work.

## 2. Cache the final IDs for each pretoken

After pretokenisation, an encoder normally runs the BPE merge loop for each span. Gigatoken memoises the final token-ID sequence for the exact bytes of each ordinary pretoken. For an unseeded pretoken, the first occurrence computes the tokenizer's normal answer; later occurrences copy the saved IDs. Each cache entry stores one pretoken's final IDs; merge histories and whole-request outputs stay outside the cache.

Pretokens up to 15 bytes use a custom short-key table, while longer ones use a separate map. The short table is seeded with exact results for vocabulary byte strings from 1 to 15 bytes. A reused tokenizer instance keeps its results across calls and continues warming.

For a fixed tokenizer, the same pretoken bytes always produce the same IDs, so the cache can replay them without changing the result. The tokenizer's own rules generate seed values because a vocabulary entry's ID can differ from the required answer. The 128-bit key contains the complete short byte string and its length, and the table compares that full key after hashing. A hash collision triggers another probe. Full-key comparison prevents it from returning another pretoken's tokens. Differential tests compare the cached path with uncached encoding across the supported tokenizer families.[^campaign][^cache]

On the author's 1 GB GPT-2/OpenWebText run, the table accumulated about 1.3 million unique short pretokens and served **99.4%** of lookups as hits. About 90% of pretoken occurrences emitted one token and 98% emitted no more than two.[^cache] In that workload, most spans skip the pair-rank lookups, merge decisions and scratch-state updates described in the next section. A hit finds the cached entry and copies its token IDs.

### Fetch the key and answer together

Once caching removes the merge algorithm from the common path, the remaining cost is a largely random table lookup. Processors fetch memory in fixed blocks called cache lines. The x86 machines discussed here use 64-byte lines; the Apple M3 Pro in my benchmark uses 128-byte lines. L1 is the smallest and fastest cache near each core; L2 and the shared last-level cache hold more data at higher latency. A load that misses them may leave the core waiting for main memory.

A short pretoken and its length fit in one 128-bit key. A hash chooses an aligned home pair in the open-addressed table. Where available, Gigatoken calculates the hash with CPU checksum instructions; other targets use a portable arithmetic fallback. Each entry is 32 bytes, so both candidates form one 64-byte probe bucket that fits within a hardware cache line on both architectures. Gigatoken loads both keys and inline values together, compares the complete keys, and selects the match in registers. The common probe requests the bucket's cache line and avoids a metadata fetch followed by a dependent random load of the value.

Collisions probe later buckets. Up to four token IDs live inside an entry; larger answers spill into a separate append-only token buffer. Offsets and lengths keep cache entries valid across buffer reallocations.

Gigatoken processes up to 256 pretokens as a group. While it discovers their spans, it asks the CPU to prefetch each future target line into L2. During the probe pass it requests promotion into L1 sixteen entries before use. The CPU may ignore a prefetch hint. When it honours one, independent work overlaps the memory fetch and reduces the chance that the probe waits for that line.

The common inline emit path also spends a few extra stores to remove control flow. It reserves room for four token IDs and writes all four lanes from the cache entry. The cursor advances only by the true count, so unused lanes are overwritten by the next result or truncated at the end. That avoids a count-dependent ladder of one-token, two-token, three-token and four-token branches.

<figure style="width:100%;max-width:calc(100vw - 3rem);margin:2.5rem 0;overflow-x:auto;">
<svg id="gigatoken-cache-line" viewBox="0 0 900 420" width="100%" style="height:auto;min-width:740px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-labelledby="gigatoken-cache-title gigatoken-cache-desc">
<title id="gigatoken-cache-title">Gigatoken's pretoken cache layout and prefetch ladder</title>
<desc id="gigatoken-cache-desc">Two 32-byte entries form one 64-byte probe bucket. A 256-span pipeline first requests the future target line in L2, then requests it in L1 sixteen probes before it is consumed.</desc>
<defs><marker id="arrow-cache" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#b87a18"/></marker></defs>
<text x="25" y="34" fill="#2c2825" font-size="16" font-weight="650">One 64-byte probe bucket</text>
<rect x="25" y="50" width="850" height="112" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<rect x="25" y="50" width="425" height="112" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<rect x="450" y="50" width="425" height="112" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<line x1="237" y1="50" x2="237" y2="162" stroke="#c2b4a0" stroke-width="2"/>
<line x1="662" y1="50" x2="662" y2="162" stroke="#c2b4a0" stroke-width="2"/>
<text x="131" y="82" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Entry 0 key</text>
<text x="131" y="107" text-anchor="middle" fill="#8a7f70" font-size="13">u128 · 16 B</text>
<text x="343" y="82" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">inline IDs + spill ref</text>
<text x="343" y="107" text-anchor="middle" fill="#8a7f70" font-size="13">up to 4 token IDs</text>
<text x="343" y="131" text-anchor="middle" fill="#8a7f70" font-size="12">16 B</text>
<text x="556" y="82" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Entry 1 key</text>
<text x="556" y="107" text-anchor="middle" fill="#8a7f70" font-size="13">u128 · 16 B</text>
<text x="768" y="82" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">inline IDs + spill ref</text>
<text x="768" y="107" text-anchor="middle" fill="#8a7f70" font-size="13">up to 4 token IDs</text>
<text x="768" y="131" text-anchor="middle" fill="#8a7f70" font-size="12">16 B</text>
<text x="25" y="211" fill="#2c2825" font-size="16" font-weight="650">Memory-latency pipeline over 256 pretokens</text>
<rect x="25" y="235" width="240" height="92" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="145" y="266" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Discover span</text>
<text x="145" y="290" text-anchor="middle" fill="#8a7f70" font-size="13">pack key + hash</text>
<text x="145" y="311" text-anchor="middle" fill="#b87a18" font-size="13">request target line in L2</text>
<path d="M265 281 H345" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-cache)"/>
<rect x="350" y="235" width="230" height="92" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="465" y="266" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">16 probes ahead</text>
<text x="465" y="290" text-anchor="middle" fill="#8a7f70" font-size="13">request line in L1</text>
<text x="465" y="311" text-anchor="middle" fill="#b87a18" font-size="13">prefetch hint</text>
<path d="M580 281 H660" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-cache)"/>
<rect x="665" y="235" width="210" height="92" rx="10" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="770" y="266" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Probe + emit</text>
<text x="770" y="290" text-anchor="middle" fill="#8a7f70" font-size="13">compare both keys</text>
<text x="770" y="311" text-anchor="middle" fill="#8a7f70" font-size="13">write 1 to 4 IDs</text>
<rect x="214" y="362" width="472" height="42" rx="9" fill="#fffaf1" stroke="#bf9a5a" stroke-width="2" stroke-dasharray="6 5"/>
<text x="450" y="388" text-anchor="middle" fill="#8a7f70" font-size="12.5">displaced hit, spill, long pretoken or miss → slow path</text>
</svg>
<figcaption style="margin-top:0.75rem;color:#8a7f70;font-size:0.85rem;line-height:1.5;">The key and the usual answer sit in the same 64-byte probe bucket, which fits within one hardware cache line. Software prefetches try to make that line resident before the probe needs it.</figcaption>
</figure>

The published A/B measures the combined probe-and-emit design: memoisation, staged prefetch, inline four-token values and flat output. On the campaign's cold 10 GB GPT-2/OpenWebText benchmark, that combination was **27.6% faster** in the single-threaded path that materialised the token IDs and **6.2% faster** on the multithreaded path.[^campaign]

### Reduce address-translation work on Linux

The cache works on ordinary memory pages. On Linux, huge pages can reduce the address-translation overhead as a randomly probed table grows. Before a core can load a cache entry, it must translate the program's virtual address into a physical address. The processor keeps recent translations in a translation lookaside buffer, or TLB. If the translation is absent, a page-table walk must find it first. On Zen, a software prefetch that misses the data TLB may be dropped, weakening the prefetch ladder described above.

A 64 MiB table occupies 16,384 ordinary 4 KiB pages. Full backing by 2 MiB huge pages reduces that to 32 pages. Gigatoken therefore aligns a large short-cache allocation to 2 MiB on Linux and calls `MADV_HUGEPAGE` before the memory is first touched. If Linux honours the hint, fewer translations have to cover the same table.

In a separate Zen 5 whole-encode comparison, huge pages reduced warm page walks from about 28.6 million to about 2,300 per pass and improved warm throughput by **7.3%**.[^pages] Because the A/B covered the input and output, the result captures address translation across the whole path. The allocation hint is Linux-specific and does nothing on macOS.

## 3. Make pretoken-cache misses cheaper

A pretoken-cache hit skips BPE. On a miss, the encoder must run the merge loop for that pretoken. Each merge changes up to two neighbouring candidates, so the next choice depends on the previous one. Gigatoken keeps that ordering serial while shortening pair-rank lookups and reusing temporary storage.

Some BPE vocabularies assign merged token IDs in merge-priority order, allowing the ID to rank a candidate. Others store merge rank separately from token ID.[^rank-order] Gigatoken preserves whichever ordering the tokenizer defines. For an ID-as-rank vocabulary that fits its packed representation, pairs whose IDs are both below 2,048 use a dense 16 MiB grid; other pairs use a packed sparse table. Both replace a general map with a shorter chain of dependent memory loads.[^miss]

Short and medium spans use fixed local rank and neighbour arrays with a linear scan. Long spans use reusable index arrays as a linked list plus a minimum heap, a priority queue that returns the lowest rank. On the ID-as-rank path, Gigatoken retains those arrays and the heap capacity between calls, avoiding fresh allocations for each cache miss. Both paths preserve merge priorities and choose the leftmost candidate when ranks tie.

On a 1 GB GPT-2 run on Zen 5, widening the dense grid to 16 MiB improved whole-encoder single-threaded throughput by **2.8%** with a cold pretoken cache.[^miss] Once warm, the cache's 99.4% hit rate starves this path of work, and the gain disappears.[^cache]

## 4. Parallelise across proven boundaries

Hugging Face Tokenizers and tiktoken parallelise across caller-supplied inputs, so a million-token document remains one item. Gigatoken finds proven boundaries inside that document and assigns its chunks to several workers.[^parallel]

Gigatoken cuts at proven pretoken boundaries, which BPE cannot cross. Added and special tokens stay intact. Inputs with no safe cut stay serial. Tests compare the parallel output with the serial token IDs in their original order.[^parallel]

### Keep coordination outside the token loop

Workers share immutable vocabulary and pair-rank tables. Each worker owns its pretoken cache and scratch buffers, keeping locks and cross-core traffic from shared writes out of the per-pretoken loop.

Workers claim chunks through an atomic counter. Because the chunks are arranged from largest to smallest, the largest are claimed first while smaller tail chunks keep cores busy near the end. Strict ordering prevents a large chunk from starting late and becoming the final straggler.[^parallel]

### Copy results while the tail is still encoding

Gigatoken reserves flat output space and uses a commit cursor to copy the ready prefix while later chunks are still encoding. This overlaps result copying and first-write page allocation with useful work. If the reservation is too small, it gathers the completed chunk buffers after encoding.[^parallel]

<figure style="width:100%;max-width:calc(100vw - 3rem);margin:2.5rem 0;overflow-x:auto;">
<svg id="gigatoken-parallel" viewBox="0 0 900 500" width="100%" style="height:auto;min-width:740px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-labelledby="gigatoken-parallel-title gigatoken-parallel-desc">
<title id="gigatoken-parallel-title">Gigatoken's coarse parallel scheduling and output assembly</title>
<desc id="gigatoken-parallel-desc">A large input is cut at pretoken-safe boundaries into large early chunks and smaller tail chunks. Worker tasks pull chunks through an atomic index, use exclusive mutable state, then copy ready chunks into a flat output buffer in input order.</desc>
<defs><marker id="arrow-parallel" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#b87a18"/></marker></defs>
<text x="25" y="31" fill="#2c2825" font-size="15" font-weight="650">One large input, cut only at safe boundaries</text>
<rect x="25" y="48" width="190" height="54" rx="7" fill="#b87a18"/>
<rect x="218" y="48" width="190" height="54" rx="7" fill="#b87a18"/>
<rect x="411" y="48" width="190" height="54" rx="7" fill="#b87a18"/>
<rect x="604" y="48" width="95" height="54" rx="7" fill="#bf9a5a"/>
<rect x="702" y="48" width="78" height="54" rx="7" fill="#bf9a5a"/>
<rect x="783" y="48" width="78" height="54" rx="7" fill="#bf9a5a"/>
<text x="313" y="81" text-anchor="middle" fill="#fffaf1" font-size="13">large head chunks</text>
<text x="733" y="81" text-anchor="middle" fill="#fffaf1" font-size="12">small tail</text>
<path d="M450 102 V142" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<rect x="275" y="147" width="350" height="52" rx="9" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="178" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">large head chunks first, then the small tail</text>
<path d="M450 199 V220" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<rect x="300" y="225" width="300" height="55" rx="9" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="248" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">shared model + atomic chunk index</text>
<text x="450" y="268" text-anchor="middle" fill="#8a7f70" font-size="12">tasks pull one chunk at a time</text>
<path d="M370 280 L170 321" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<path d="M450 280 V321" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<path d="M530 280 L730 321" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<rect x="55" y="326" width="230" height="92" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<rect x="335" y="326" width="230" height="92" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<rect x="615" y="326" width="230" height="92" rx="10" fill="#fffaf1" stroke="#b9ab95" stroke-width="2"/>
<text x="170" y="353" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Worker task 0</text>
<text x="170" y="377" text-anchor="middle" fill="#8a7f70" font-size="12">exclusive cache + scratch</text>
<text x="170" y="399" text-anchor="middle" fill="#b87a18" font-size="12">chunk token buffer</text>
<text x="450" y="353" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Worker task 1</text>
<text x="450" y="377" text-anchor="middle" fill="#8a7f70" font-size="12">exclusive cache + scratch</text>
<text x="450" y="399" text-anchor="middle" fill="#b87a18" font-size="12">chunk token buffer</text>
<text x="730" y="353" text-anchor="middle" fill="#2c2825" font-size="14" font-weight="650">Worker task N</text>
<text x="730" y="377" text-anchor="middle" fill="#8a7f70" font-size="12">exclusive cache + scratch</text>
<text x="730" y="399" text-anchor="middle" fill="#b87a18" font-size="12">chunk token buffer</text>
<path d="M170 418 V451 H390" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<path d="M450 418 V451" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<path d="M730 418 V451 H510" fill="none" stroke="#b87a18" stroke-width="2.5" marker-end="url(#arrow-parallel)"/>
<rect x="285" y="451" width="330" height="42" rx="9" fill="#f1e7d3" stroke="#b9ab95" stroke-width="2"/>
<text x="450" y="477" text-anchor="middle" fill="#2c2825" font-size="13.5" font-weight="650">commit cursor copies chunks in input order</text>
</svg>
<figcaption style="margin-top:0.75rem;color:#8a7f70;font-size:0.85rem;line-height:1.5;">Each active task holds one mutable state slot exclusively. Shared work distribution and output assembly operate at chunk granularity.</figcaption>
</figure>

In separate A/B comparisons, the 16-thread path was **6.2% faster** with strict handout plus parallel gathering and **4.4% faster** with opportunistic prefix copying, each against its own control.[^parallel]

The closest published total comes from the campaign's final same-session comparison on a cold 10 GB GPT-2/OpenWebText encode. Its documented single-thread path reached **1,039 MB/s**, while the 16-thread path reached **8,792 MB/s**. That is about **8.5x the wall throughput**, equivalent to cutting the 10 GB encode from roughly **9.6 to 1.14 seconds**. Each worker runs the scanner, cache and miss paths described above, so parallelism scales the faster core.[^parallel]

### What parallelism costs

Exclusive worker state removes shared-cache locking from the per-pretoken hot path. The trade-off is a cache per worker and duplicated warm-up work. In the author's 16-worker profile, the state slots accumulated about 16 million distinct entries between them, compared with 5.5 million for a single cache. Aggregate multithreaded CPU time was 14.7 seconds against roughly 11 seconds for Gigatoken's single-thread run, even though wall time fell sharply. The request finished sooner by spending more aggregate CPU work and memory.

Initial short-cache sizing is clamped between roughly 2 and 128 MiB per state slot, depending on the predicted share of the batch. The tables can continue to grow, however. The short cache has no eviction, and the long-key maps and token arenas are append-only. The pool keeps that memory across requests. One user processing several terabytes reports in an open issue that Gigatoken eventually consumed the RAM and swap of a 1 TB server.[^memory]

The wall-time gain therefore comes with a production requirement: long-running workloads with continually changing input need a way to bound or evict retained cache state.

## What the Rust core achieved

Gigatoken's 1,000x headline compares its native whole-buffer API with Hugging Face Tokenizers through its Python-facing batch API. Hugging Face's encoder also runs multithreaded Rust. The headline includes the advantages of handing Gigatoken one 11.9 GB byte buffer, letting it find its own split points and avoiding compatibility work at the Python boundary.[^headline]

My service already used a multithreaded Rust tokenizer core. My benchmark therefore compared two Rust cores. As I reported in [my first Gigatoken post](/gigatoken-thousand-times-faster/), the timed million-token, 1,024-segment count path fell from about 159 milliseconds to 4.24 milliseconds, a **37.6x speed-up**.

Together, the four mechanisms show how Gigatoken changes the way tokenisation runs on the hardware: classify 64 bytes at once, lay common cache probes out in 64-byte buckets, shorten the BPE miss path and parallelise at safe boundaries. GPU kernels receive this scrutiny as a matter of course. CPU preprocessing should too.

[^clear-bit]: Here `&=` means "replace the value on the left with the result of a bitwise AND". For a non-zero mask, subtracting one changes its lowest `1` bit to `0` and all the lower `0` bits to `1`. ANDing that with the original clears only the lowest set bit: `1011000 & 1010111 = 1010000`. `trailing_zeros` finds that bit's position before it is cleared, so the next iteration can move to the following boundary.
[^source]: This article follows the [Gigatoken source revision used in my benchmark](https://github.com/marcelroed/gigatoken/tree/542367a3efed134883fb4f1140b49c04e6fad3a3). Marcel Rød's [profiling campaign](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md) records the measurements and rejected experiments.
[^headline]: Gigatoken's [README](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/README.md#L1-L58) describes the headline comparison, notes that Hugging Face Tokenizers already runs multithreaded Rust and says Gigatoken's compatibility mode falls short of 1,000x. The [benchmark method](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/benchmarks/compare/measure.py#L19-L27) gives Hugging Face pre-split Python strings and Gigatoken one unsplit byte buffer.
[^native-api]: The cleanest controlled measurement I found covers the input boundary. Gigatoken replaced a corpus pre-split into per-document Python objects with borrowed byte buffers and separator splitting inside Rust. The author measured it [**11% to 16% faster** on 300 MB and the full 11.9 GB OpenWebText corpus, with identical token IDs](https://github.com/marcelroed/gigatoken/commit/97678e8d1dd2426035909235e03bbafeeefe6cc1). Output materialisation and a full native-versus-compatibility multiplier remain unmeasured.
[^bpe]: Byte pair encoding was introduced as a compression technique and adapted for subword tokenisation in [Neural Machine Translation of Rare Words with Subword Units](https://arxiv.org/abs/1508.07909). OpenAI's educational [tiktoken implementation](https://github.com/openai/tiktoken/blob/main/tiktoken/_educational.py#L23-L37) shows the repeated lowest-rank adjacent-pair merges during encoding.
[^campaign]: See the [campaign summary and method](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L1-L47), its [round-by-round results](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L110-L184) and the [whole-encoder speculation profile](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L225-L269).
[^scanner]: The source documents the shared [mask-scanner architecture](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/mask.rs#L1-L33), [architecture-specific SIMD front ends](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/mask.rs#L174-L328) and [GPT-2 boundary algebra](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/r50k.rs#L164-L240). The [r50k module notes](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/r50k.rs#L1-L35) define the scalar path and report the isolated throughput. Separate mask implementations cover [Qwen 2/3](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/qwen2.rs#L1-L18) and [GPT-4o/o200k](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/o200k.rs#L1-L35), while [DeepSeek uses a specialised scalar walker](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/deepseek_v3.rs#L1-L22). The r50k module also contains [edge-case, fuzz and OpenWebText differential tests](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/r50k.rs#L759-L894).
[^bitparallel]: Cameron et al.'s 2014 paper, [*Bitwise Data Parallelism in Regular Expression Matching*](https://www2.cs.sfu.ca/~ashriram/papers/2014_PACT_GREP.pdf), presents a general regex algorithm built from bitwise logic, shifts and one-bit-per-input-position streams. Langdale and Lemire's [simdjson paper](https://arxiv.org/abs/1902.08318) describes a two-stage parser built around SIMD classification of input blocks; Gigatoken's source calls its own movemask primitive [simdjson-style](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/mask.rs#L85-L88). Gigatoken applies these established techniques to fixed tokenizer patterns.
[^unicode]: Gigatoken's [packed Unicode tables](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/unicode.rs#L50-L240) and [Unicode mask fill](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/mask.rs#L402-L548) preserve the fast mask representation. The [r50k fallback](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/fast/r50k.rs#L243-L411) handles ambiguous regions.
[^cache]: The cache module records the [1 GB OpenWebText distribution and layout rationale](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/pretoken_cache.rs#L1-L31). The implementation documents [exact cache seeding](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/tiktoken.rs#L343-L417), [key packing and hardware CRC hashing](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/mod.rs#L81-L213), [paired cache probes](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/pretoken_cache.rs#L381-L464) and the [staged prefetch loop](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/tiktoken.rs#L1040-L1162).
[^pages]: The [Zen 5 profile](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/zen5_st_profile.md#L121-L202) diagnoses the translation cost and measures the fix. The Linux kernel documentation explains [transparent huge pages](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html).
[^rank-order]: In an ID-as-rank vocabulary, merged token IDs follow merge priority. Other BPE vocabularies can assign the two independently. If `b + c` is rank 0 and produces ID 350 while `a + b` is rank 1 and produces ID 300, `b + c` must still merge first. Gigatoken's loader [checks whether merged IDs follow rank order](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/load_tokenizer/hf.rs#L744-L769), and the source includes a [reversed-ID test](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/load_tokenizer/hf.rs#L931-L960).
[^miss]: The source explains the [dense and sparse PairRankTable layout](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/mod.rs#L108-L250) and the [explicit-rank alternative](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/bpe/tiktoken.rs#L20-L44). The Zen 5 profiling notes record the [16 MiB dense-grid A/B](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/x86_port_plan.md#L385-L416).
[^parallel]: Hugging Face's [`encode_batch_fast`](https://github.com/huggingface/tokenizers/blob/v0.21.4/tokenizers/src/tokenizer/mod.rs#L1307-L1318) parallelises over the input vector, one encode call per item. Gigatoken's [benchmark notes](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/README.md#L218-L224) say that Hugging Face and tiktoken receive pre-split documents while Gigatoken receives the whole file and discovers its own split boundaries. The implementation documents [safe split points](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/mod.rs#L570-L659), [equivalence and added-token tests](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/pretokenize/mod.rs#L716-L832), [tail-aware chunk sizing](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L164-L189), [strict work handout](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L521-L613) and [opportunistic output commits](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L335-L517). The parallel path is compared with serial output in [unit tests](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L1061-L1124) and an [ignored 1 GB OpenWebText test with added tokens](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L1399-L1495). The profiling campaign measures [6.2% for strict handout plus parallel gather](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L146-L163) and [4.4% for opportunistic prefix copying](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L190-L213). Its [final same-session comparison](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L17-L34) reports 8,792 MB/s for the 16-thread ragged path and 1,039 MB/s for the single-thread materialising path on the same cold 10 GB campaign. The two benchmark entry points produce slightly different token counts in their [100 MB identity checks](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/campaign_report.md#L61-L67), so the 8.5x figure cannot isolate parallel scaling. Gigatoken implements a [token-identical serial ragged path](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/src/batch.rs#L783-L807); no timing is published for it.
[^memory]: The [multithreaded profile](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/profiling/mt4_analysis/mt_round4_findings.md#L55-L69) quantifies duplicated cache work. The current cache has no eviction; [issue #36](https://github.com/marcelroed/gigatoken/issues/36) reports unbounded growth in a long-running terabyte-scale job.
[^scope]: Gigatoken's [README](https://github.com/marcelroed/gigatoken/blob/542367a3efed134883fb4f1140b49c04e6fad3a3/README.md#L261-L265) distinguishes its heavily optimised BPE tokenizer path from SentencePiece and lists WordPiece as unsupported.
