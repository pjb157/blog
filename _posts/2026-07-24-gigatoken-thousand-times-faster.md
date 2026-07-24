---
layout: post
title: "Gigatoken: A Thousand Times Faster?"
date: 2026-07-24
description: "Gigatoken claims a 1,000x tokenizer speedup. My production-shaped tests delivered 30x to 42x gains in the tokenizer core."
tags: [ai, performance, tokenization]
image: /assets/images/gigatoken-cover.webp
---

[Gigatoken](https://github.com/marcelroed/gigatoken) claims to be roughly **1,000 times faster** than Hugging Face Tokenizers. The implementation is impressive, but that headline needs a narrower label.

Gigatoken's figure measures its fastest path over an 11.9 GB OpenWebText file. My use case is an online tokenizer: mixed text, requests ranging up to a one-million-token context window, sometimes split into 1,024 segments, with an HTTP boundary around the work.

I measured between **30x and 42x** in the tokenizer core. That is a large improvement, but the gap from 1,000x is too wide to dismiss as benchmark noise.

## Where the thousand comes from

Tokenization looks sequential. Split text into pieces, merge byte pairs, emit token IDs. The normal implementation is already fast Rust, but parts of its hot path still behave like general software. A regex engine performs pretokenization. Bounds checks and unpredictable branches sit inside tight loops. Threads exchange work. Language bindings move data between Python and Rust.

Gigatoken treats those costs as the problem.

Its pretokenizers replace general regex execution with specialised state machines. Lookup tables classify bytes directly. SWAR and architecture-specific SIMD inspect several bytes per instruction. Common byte-pair results are cached so repeated words can skip most of the merge work. The implementation also works hard to keep branches predictable, memory local and workers independent.[^implementation]

There is a second source of speed in the headline benchmark. The native API reads a large file directly and finds safe boundaries where it can divide the stream between cores. This removes Python data conversion and gives the scheduler an enormous, regular slab of work. On a 144-core AMD EPYC machine, Gigatoken reports 24.53 GB/s for GPT-2 against 24.8 MB/s for Hugging Face, or 989x. On an Apple M4 Max it reports 8.79 GB/s against 6.9 MB/s, or 1,268x.[^benchmark]

Those figures show what the implementation can do when the workload is shaped around its fastest API. Gigatoken's own documentation says its compatibility mode is slower and does not reach 1,000x. The headline is therefore a best case, rather than a general expectation for replacing an existing tokenizer.

## What happened in my workload

I compared Gigatoken with the Hugging Face [`tokenizers`](https://github.com/huggingface/tokenizers) Rust library using identical prepared bytes. Before timing anything, I required the two implementations to produce the same token IDs. The parity checks passed across representative BPE, byte-fallback and tiktoken-style model families.

The preliminary direct results below use a GLM tokenizer on an Apple M3 Pro. Each workload contains mixed prose, code and structured text.

| Workload | Tokens per batch | Segments | Hugging Face | Gigatoken | Speedup |
|---|---:|---:|---:|---:|---:|
| Small suffix | 2,017 | 8 | 4.2M tok/s | 168.3M tok/s | **40.1x** |
| Chat prefix | 32,189 | 64 | 6.3M tok/s | 199.4M tok/s | **31.8x** |
| Long prefix | 257,218 | 384 | 6.7M tok/s | 201.4M tok/s | **30.0x** |
| Million-token segmented | 1,009,322 | 1,024 | 6.3M tok/s | 238.2M tok/s | **37.6x** |

Gigatoken sustained roughly 168 to 238 million tokens per second as the batch grew towards the context limit. The baseline stayed near 4 to 7 million.

## The missing 970x

My service cannot hand Gigatoken an 11.9 GB file and disappear. It receives bounded requests, preserves segment boundaries, returns nested results and pays for HTTP, serialisation and scheduling. The baseline is also called through its native Rust interface, so Gigatoken cannot win by removing Python overhead that was never present.

Small requests expose fixed costs. Segmentation limits how freely work can be divided. At the HTTP boundary, faster tokenization leaves a larger fraction of time in everything surrounding it. Amdahl's law arrives quickly when the accelerated part becomes fast enough.

The 1,000x headline did not survive this workload. The million-token segmented case was **37.6x faster**, cutting core processing time from about 159ms to 4ms while preserving every token ID. That is an impressive engineering result and a useful production result. Gigatoken does not need the broad 1,000x claim to be worth taking seriously.

[^implementation]: Marcel Rød's [optimization notes](https://github.com/marcelroed/gigatoken/blob/main/pretokenizer_optimization_log.md) walk through lookup-table dispatch, SWAR scanning, branch removal and dual-cursor instruction-level parallelism. The project README also describes caching and reduced communication between workers.
[^benchmark]: The [Gigatoken benchmark table](https://github.com/marcelroed/gigatoken#benchmarks) reports results by tokenizer and CPU. Its Hugging Face comparison uses a pre-split 100 MB subset, while Gigatoken processes the complete 11.9 GB file and discovers boundaries itself.
