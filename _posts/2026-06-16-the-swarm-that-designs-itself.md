---
layout: post
title: "The swarm that designs itself: building the Doubleword Agent Swarm"
date: 2026-06-16
description: "I rebuilt Moonshot's Kimi agent swarm and pointed it at a real codebase: ~53× fewer tokens and ~45× cheaper than one long-context agent."
tags: [ai, agents, inference, kimi]
image: /assets/images/bees.jpg
---

Faced with a hard task, the instinct is to reach for more: a smarter model, a longer context window, one capable agent that can hold the whole problem in its head at once. The entire frontier is racing along that axis, chasing more intelligence and more context, and it has handed me a great tool. For deep, sequential problems, a single long-context agent is a superb one: the best hammer I've ever had.

And so I reach for it for everything. When it can't crack a task, the reflex isn't to ask whether a hammer was the right tool. It's to reach for a bigger one: wait for the next model, with a longer window and a higher benchmark. But hand someone a hammer and everything starts to look like a nail. Some tasks were never nails.

So is there another way? For one shape of work, very much so. A lot of real work isn't deep and sequential. It's *wide and shardable*: audit every file in this repo, review every dependency, document every subsystem, check every source. Point a single long-context agent at that and it'll get there, but you will pay dearly for the privilege.

That question is why I built the [Doubleword Agent Swarm](https://github.com/doublewordai/swarm), my open-source reimplementation of the agent swarm Moonshot introduced in the [Kimi K2.5 report](https://arxiv.org/abs/2602.02276): an LLM orchestrator **designs its own team** of bounded-context workers and fans them out in parallel over a task. This post is the story of how I built it, and what happened when I pointed it at a real codebase, side by side with a single long-context agent.

The short version: for wide, shardable work, a swarm of bounded agents beats one long-context agent on cost and on output. The model designs the team. I build the scaffolding, and it's small.

## What the hammer costs

To make it concrete, I picked a job I actually needed done: a security audit of [control-layer](https://github.com/doublewordai/control-layer), Doubleword's open-source AI gateway: 512 source files, about 2.4M tokens of unique source. Find real vulnerabilities: injection, leaked secrets, broken auth, unsafe file handling. Same task, two ways.

First, the hammer: a single agent on Claude Opus with a 1M-token window, no chunking, just "audit the repo". The problem isn't that it can't. The problem is what it costs. An agent loop re-sends the growing transcript with every turn, so by the time my metered run had covered ~7% of the repo, it had already burned 27.7M tokens, 95% of them cache reads, the same transcript shipped back again and again.[^1] Projected over the full repo, the audit lands around **300M tokens**: a 2.4M-token codebase, amplified ×125.

[^1]: A real metered run, not a thought experiment. The agent repeatedly fills its window, hits the compaction ceiling, summarises, and grows again. With prompt caching, the projected full-repo bill is ~$300; without it, ~$1,800.

<figure style="margin:2rem 0;">
<svg viewBox="0 0 760 130" width="100%" style="height:auto;max-width:640px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-label="Tokens to audit control-layer: read once 2.4M versus solo agent projected 300M">
<text x="0" y="40" font-size="13" fill="#2c2825">Read once · the corpus</text>
<rect x="200" y="24" width="4" height="24" rx="2" fill="#b3a896"></rect>
<text x="212" y="40" font-size="13" fill="#8a7f70">2.4M</text>
<text x="0" y="90" font-size="13" fill="#2c2825">Solo agent · projected</text>
<rect x="200" y="74" width="460" height="24" rx="2" fill="#b87a18"></rect>
<text x="672" y="90" font-size="13" font-weight="600" fill="#2c2825">~300M</text>
</svg>
<figcaption style="text-align:center;color:#8a7f70;font-size:0.85rem;font-style:italic;margin-top:0.6rem;font-family:-apple-system,system-ui,sans-serif">Reading the 2.4M-token corpus once, against the ~300M a single long-context agent re-sends: a ×125 amplification.</figcaption>
</figure>

Reading the codebase costs 2.4M tokens, once. *Re-reading it* is the bill.

## The alternative: a swarm

The waste was never the reading. It was the *re*-reading: one context dragging the whole codebase along on every turn. The fix almost writes itself. Don't hand the whole repo to a single agent at all; split it across many bounded workers, each reading only its own slice, once, all at the same time. That's an agent swarm.

It's the paradigm every company already runs on. The CEO is the most capable (and most expensive) person in the building, and exactly the wrong one to personally trawl through every file. So they don't: they hire specialists with tight remits, hand each a bounded task, and never see the mountain of material those specialists wade through. What comes back is a short, high-level summary: the result, not the raw work. Same setup here, just with agents: the orchestrator plays CEO, the workers are its specialists, and only their conclusions ever travel back up.

That's the whole idea. The interesting question is who designs the team.

In February 2026, Moonshot published the Kimi K2.5 technical report.[^2] Its agent-swarm result is the framework I built on: scale *out*, not just up. A trainable orchestrator spawns specialised sub-agents and runs them in parallel, trained with PARL (Parallel-Agent Reinforcement Learning), where only the orchestrator learns and the sub-agents stay frozen. The headline numbers: 4.5× lower latency than a single agent, and +17.8 points on BrowseComp.[^3] The part I found genuinely new: **the swarm designs itself**. Decomposition and team width are the model's call, not a hand-written workflow.

[^2]: [Kimi K2.5: Visual Agentic Intelligence](https://arxiv.org/abs/2602.02276), Kimi Team, February 2026. See also Moonshot's [agent swarm post](https://www.kimi.com/blog/agent-swarm).

[^3]: 60.6 → 78.4 on BrowseComp, a deep-research benchmark, versus the single-agent baseline.

Then the catch. What's in the weights is the orchestration *instinct*: how to decompose, delegate, reconcile. The runtime that makes a swarm real (spawn, isolate, parallelise, aggregate) lives in Moonshot's hosted product, not in the open weights. An open endpoint gives me exactly what it has always given me: messages and tools in, tool calls and text out.

So that became the project: the weights bring the instinct, I build the body. [doublewordai/swarm](https://github.com/doublewordai/swarm) is that body, my from-scratch interpretation of Moonshot's swarm, built on the [Open Responses API](https://openresponses.org), model-agnostic (default: `moonshotai/Kimi-K2.6`).[^credit]

[^credit]: Full credit to Moonshot for the pattern. The repo's README has a ["Faithful to Kimi"](https://github.com/doublewordai/swarm#faithful-to-kimi) section spelling out what I reproduced (the self-designing orchestrator, context sharding, the critical-steps metric), what I deliberately dropped (PARL training, the mutating toolbox), and what's mine.

## The architecture

Everything I kept from the paper, and everything I added, compresses to four principles:

1. **A self-designing orchestrator.** The model decides the team and the decomposition, not me.
2. **Bounded local context.** Each worker sees only its slice, and returns only results.
3. **Structural anti-groupthink.** Independent verification before any finding counts.
4. **Synthesis.** One final pass reconciles everything into a deliverable.

<figure style="margin:2rem 0;overflow-x:auto;">
<svg viewBox="0 0 940 300" width="100%" style="height:auto;min-width:640px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-label="Swarm pipeline: repo, orchestrator, parallel workers, verifiers, synthesizer, report">
<defs><marker id="sw-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#c2b4a0"></path></marker></defs>
<rect x="16" y="114" width="92" height="60" rx="8" fill="none" stroke="#b9ab95" stroke-width="1.5"></rect>
<text x="62" y="142" text-anchor="middle" font-size="16" fill="#2c2825">repo</text>
<text x="62" y="160" text-anchor="middle" font-size="12" fill="#8a7f70">→ map</text>
<line x1="112" y1="144" x2="134" y2="144" stroke="#c2b4a0" stroke-width="1.5" marker-end="url(#sw-arrow)"></line>
<text x="140" y="100" font-size="12" letter-spacing="0.14em" fill="#b87a18">01</text>
<rect x="140" y="108" width="140" height="72" rx="8" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.5"></rect>
<text x="210" y="142" text-anchor="middle" font-size="17" fill="#2c2825">orchestrator</text>
<text x="210" y="161" text-anchor="middle" font-size="12" fill="#8a7f70">designs the team</text>
<line x1="284" y1="144" x2="322" y2="90" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<line x1="284" y1="144" x2="322" y2="144" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<line x1="284" y1="144" x2="322" y2="198" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<text x="322" y="52" font-size="12" letter-spacing="0.14em" fill="#b87a18">02 · WAVE · PARALLEL</text>
<rect x="322" y="70" width="150" height="40" rx="7" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.25"></rect>
<text x="338" y="94" font-size="13" fill="#2c2825">worker</text>
<text x="458" y="94" text-anchor="end" font-size="11" fill="#8a7f70">scoped task</text>
<rect x="322" y="124" width="150" height="40" rx="7" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.25"></rect>
<text x="338" y="148" font-size="13" fill="#2c2825">worker</text>
<text x="458" y="148" text-anchor="end" font-size="11" fill="#8a7f70">scoped task</text>
<rect x="322" y="178" width="150" height="40" rx="7" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.25"></rect>
<text x="338" y="202" font-size="13" fill="#2c2825">worker</text>
<text x="458" y="202" text-anchor="end" font-size="11" fill="#8a7f70">scoped task</text>
<text x="397" y="236" text-anchor="middle" font-size="12" font-style="italic" fill="#8a7f70">…hundreds in parallel · bounded context</text>
<line x1="472" y1="90" x2="502" y2="144" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<line x1="472" y1="144" x2="502" y2="144" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<line x1="472" y1="198" x2="502" y2="144" stroke="#c2b4a0" stroke-width="1.25" marker-end="url(#sw-arrow)"></line>
<text x="500" y="120" text-anchor="end" font-size="11" fill="#8a7f70">findings only</text>
<text x="508" y="100" font-size="12" letter-spacing="0.14em" fill="#b87a18">03</text>
<rect x="508" y="108" width="120" height="72" rx="8" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.5"></rect>
<text x="568" y="142" text-anchor="middle" font-size="17" fill="#2c2825">verifiers</text>
<text x="568" y="161" text-anchor="middle" font-size="12" fill="#8a7f70">refute · survive</text>
<line x1="632" y1="144" x2="660" y2="144" stroke="#c2b4a0" stroke-width="1.5" marker-end="url(#sw-arrow)"></line>
<text x="666" y="100" font-size="12" letter-spacing="0.14em" fill="#b87a18">04</text>
<rect x="666" y="108" width="126" height="72" rx="8" fill="#f1e7d3" stroke="#b87a18" stroke-width="1.5"></rect>
<text x="729" y="142" text-anchor="middle" font-size="17" fill="#2c2825">synthesizer</text>
<text x="729" y="161" text-anchor="middle" font-size="12" fill="#8a7f70">reconcile</text>
<line x1="796" y1="144" x2="820" y2="144" stroke="#c2b4a0" stroke-width="1.5" marker-end="url(#sw-arrow)"></line>
<rect x="826" y="114" width="100" height="60" rx="8" fill="none" stroke="#b9ab95" stroke-width="1.5"></rect>
<text x="876" y="149" text-anchor="middle" font-size="14" fill="#2c2825" font-family="'SF Mono','Cascadia Code',monospace">report.md</text>
<path d="M397 220 C 397 272, 210 272, 210 186" fill="none" stroke="#bf9a5a" stroke-width="1.25" stroke-dasharray="4 4" marker-end="url(#sw-arrow)"></path>
<text x="304" y="288" text-anchor="middle" font-size="11" fill="#9a8f80">status + unreported files → gap-fill wave</text>
</svg>
</figure>

Left to right: the repo is cloned and compressed into a budgeted map; the orchestrator designs a team and dispatches scoped tasks in parallel *waves*; ephemeral workers investigate and return findings only; findings are deduped, challenged by verifiers, and reconciled by a synthesizer into `report.md`. Four blocks, one per principle.

### Block 1: the orchestrator designs the team

The orchestrator gets the repo map up front and can probe with `read_file` and `grep` before committing to a plan. Then it builds its team with two tools, `create_subagent(name, system_prompt)` and `assign_task(agent, prompt)`, the literal tool surface Kimi K2.5/K2.6 were RL-trained on.[^4] It authors each specialist's system prompt itself. In one real audit run it invented a persona I never asked for:

```python
# the orchestrator wrote this prompt (persona registered once)
create_subagent(
    name="injection-filesystem",
    system_prompt="You hunt injection and unsafe file access…",
)

# every task spawns a fresh agent with that persona
assign_task("injection-filesystem", "Audit cli.py …")
assign_task("injection-filesystem", "Trace cost.py …")
```

[^4]: K2.5 technical report, Appendix E.8: this is `--interface kimi`, which the repo ships as the default. I also ship `--interface structured`, where the orchestrator instead calls `dispatch_workers([{role, focus, paths}])` and the harness preloads each worker's files, decomposing by directory rather than by task, which keeps the planning turn small on very large repos.

The division of labour matters: the model decides *who* does *what*; the harness decides which tools each role may hold. Each dispatching turn is a wave: width is parallelism, follow-up waves fill gaps.

### Block 2: workers see only their slice

This is the paper's key lever, the one that pays for everything: **context sharding**. Each task spawns a fresh, throwaway agent. It self-gathers exactly the context it needs (`read_file`, `grep`, plus whatever capability tools its role grants), works for a few rounds, calls `submit_results`, and is gone. Only schema-valid results and a status line return to the orchestrator; the worker's research is discarded, never re-sent.

Context integrity and cost turn out to be the same lever pulled once: no single context ever overflows, *and* per-agent token usage stays low. That's why fanning out hundreds of workers stays cheap, and why the 300M-token bill from earlier never materialises. (The v1 toolset is deliberately read-only, so it's safe to point at any repo.)

### Block 3: every finding meets a skeptic

A swarm of enthusiastic hunters produces enthusiastic false positives. So before anything counts, each candidate finding is handed to an independent verifier whose only job is to **refute it**, and which defaults to "not real" when unsure. Survivors ship with adjusted severity; refuted findings are dropped and counted.

This stage is my addition; the paper's orchestrator reconciles inline. It's optional and per-brief; `--verify-votes N` turns it into a majority-vote panel.

### Block 4: one pass writes the report

Finally, a single tool-free synthesis call reconciles the confirmed findings into the deliverable: `report.md` for humans, `findings.json` for machines. Its shape comes from the brief, not the engine, which brings me to the part I like most.

## Swap the brief, keep the engine

Nothing in the engine mentions auditing. The loop (orchestrate, shard, verify, synthesize) is byte-identical for every task. What a swarm *does* is a **brief**: ~50 lines of data binding prompts to roles, a result schema (enforced at `submit_results`: invalid items are dropped, not trusted), and a tool selection per role:

```python
# src/briefs/onboarding.py (abridged)
from . import Brief, register

register(Brief(
    name="onboarding",
    description="Document a codebase's subsystems for newcomers.",
    orchestrator_prompt="You are the lead author … call dispatch_workers once …",
    worker_prompt="Document ONLY your assigned files: purpose, key components, deps …",
    synthesis_prompt="Assemble an onboarding guide: overview, per-subsystem sections …",
    result_schema={...},
    result_key="sections",
    worker_tools=("read_file", "grep"),
    verifier_prompt=None,   # set a prompt to switch the adversarial verify stage on
))
```

Two briefs ship in the box, `audit` and `onboarding`, and the ones I could write are an afternoon each: a dependency review (one worker per dependency: version drift, advisories, upgrade risk), a refactor plan (workers map usage per module, the synthesizer sequences the steps), wide research (one worker per source; verifiers refute unsupported claims).

## The receipts

Same repo, same task, both ways:

| | Solo agent (Claude Opus) | Swarm (Kimi K2.6) |
|---|---|---|
| Tokens | ~300M · projected | 5.6M · measured |
| Cost | ~$300 | ~$6.70 |
| vs. the 2.4M read-once floor | ×125 | ×2.3 |

<figure style="margin:2rem 0;">
<svg viewBox="0 0 760 130" width="100%" style="height:auto;max-width:640px;display:block;margin:0 auto;font-family:-apple-system,'Segoe UI',system-ui,sans-serif" role="img" aria-label="Same audit: solo agent projected 300M tokens versus swarm measured 5.6M">
<text x="0" y="40" font-size="13" fill="#2c2825">Solo agent · projected</text>
<rect x="200" y="24" width="460" height="24" rx="2" fill="#b3a896"></rect>
<text x="672" y="40" font-size="13" fill="#8a7f70">~300M</text>
<text x="0" y="90" font-size="13" fill="#2c2825">Swarm · measured</text>
<rect x="200" y="74" width="9" height="24" rx="2" fill="#b87a18"></rect>
<text x="217" y="90" font-size="13" font-weight="600" fill="#b87a18">5.6M</text>
</svg>
<figcaption style="text-align:center;color:#8a7f70;font-size:0.85rem;font-style:italic;margin-top:0.6rem;font-family:-apple-system,system-ui,sans-serif">The same audit: the solo agent's projected ~300M tokens against the swarm's measured 5.6M, about 53× fewer.</figcaption>
</figure>

The swarm's run, measured: 348 API calls, 5.2M tokens in, ~450k out, about **53× fewer tokens and 45× cheaper** at Doubleword's Kimi K2.6 pricing ($0.95/M input, $4/M output).[^5] And the output held up: the verifier stage refuted and dropped roughly half of the candidate findings before any of them reached me, so what survived came with severity, `file:line`, and a suggested fix attached.

[^5]: Solo figures are projected from the metered partial run, with prompt caching priced in; swarm figures are measured. Every run also writes `summary.json` with tokens, cost, coverage, and the paper's critical-vs-total step counts: `speedup = total / critical` scores how well the orchestrator actually parallelised, the way the paper scores it.

## Nobody's waiting: the flex tier

One more flag. A swarm is the definition of a [just-get-it-done workload](https://blog.doubleword.ai/inference-when-no-one-is-waiting): hundreds of concurrent calls and no human watching any single one. The workload is throughput-bound, not latency-bound: what matters is when the whole wave lands, not when each call does.

That's exactly what Doubleword's flex tier prices for. Individual calls may run longer, but global throughput holds, so end-to-end wall-clock stays roughly the same, at ~30% off.[^6]

```python
service_tier = "flex"   # was "priority"
```

[^6]: Tier discounts are per-model; ~30% is Doubleword's flex pricing for Kimi K2.6 at the time of the run. `swarm compare <brief> --repo …` runs the identical workload on both tiers and writes the wall-clock / token / cost table, so you can measure the trade on your own job.

## Run it on your repo

The quickest path is the [dw CLI](https://docs.doubleword.ai), which sets up auth, endpoint, and model in one step:

```bash
dw login
dw examples clone swarm
cd swarm
dw project setup
```

Then point a brief at a repo:

```bash
dw project run audit      -- --repo psf/requests --max-files 20         # audit a GitHub repo
dw project run onboarding -- --path ./my-service                        # document a local directory
dw project run audit      -- --repo psf/requests --service-tier flex    # run on flex tier for 30% cost saving!
dw project run report                                                   # print the latest run's report
```

Each run writes `results/<brief>-<slug>/`: the synthesized `report.md`, structured `findings.json`, `swarm-tree.json` (the team the orchestrator designed, worth reading at least once), and `summary.json` with tokens, cost, and step counts.

Everything is open: the harness is [on GitHub](https://github.com/doublewordai/swarm), it speaks the [Open Responses API](https://openresponses.org), and it's model-agnostic: `-m` any tool-caller you like, Doubleword's or otherwise.

[Doubleword](https://doubleword.ai) is built for exactly this kind of high-throughput inference, and I'd love to see what you fan out. Clone the swarm, write a brief, and go run parallel agents.
