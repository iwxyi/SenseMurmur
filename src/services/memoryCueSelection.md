# Memory Cue Selection

This layer separates memory retrieval from prompt-visible memory use.

Retrieval may return a wider candidate set so weak but useful continuity is not missed. The generation prompt must not receive that full candidate set. Before prompt injection, `selectConstrainedMemoryCues` chooses 0-3 constrained cues and assigns a visible-use mode:

- `implicit_only`: use as private influence only. The model must not say "you said before", "last time", or "I remember".
- `light_reference`: one casual callback is allowed when the current turn naturally touches the memory.
- `explicit_reference`: allowed when the user directly asks or the task requires a factual recall.
- `corrective`: use to correct ownership, joke/test statements, or contradicted memories without turning them into stable user traits.

The selector is intentionally not vector-based. Current retrieval relies on text overlap, semantic tags, associations, salience, confidence, recency, and risk penalties. This is enough for the first production path because upstream memory distillation should produce structured semantic metadata. Vector search can be added later as another candidate source, but it must not bypass the cue selector or privacy/ownership rules.

Important distinction:

- Candidate memories answer "what might be related?"
- Constrained cues answer "what may influence this specific reply, and how?"

Prompt generation should only see constrained cues. If candidate memories exist but no cue is selected, the prompt should explicitly avoid inventing prior user facts or quoting memory contents.

## Settings Boundaries

Memory settings are intentionally split by user intent:

- `聊天-记忆` controls production memory recall during chat generation: enabled state, visible recall style, max cues per turn, and recent-use cooldown.
- `聊天-陪伴` controls proactive companionship such as check-ins, rituals, private chats between characters, and quiet hours. It must not be used as the memory recall switch.
- Developer options expose memory evidence, metrics, and distillation events for debugging only.
- Plugin experiments are reserved for high-cost or not-yet-stable enhancements such as a synchronous LLM memory gate or vector recall. Those experiments must not bypass this selector.

Privacy filters, third-party ownership checks, contradicted-memory handling, and `never_surface` visibility are enforced safety rules, not ordinary product toggles.

## Metadata Contract

`MemoryItem` and `MemoryCandidate` support optional recall metadata:

- `subjectOwner`: whether the fact belongs to the user, current speaker, current target, a third party, or an unknown group fact.
- `sourceType`: serious, joke, test, correction, temporary, distilled, or runtime.
- `privacyRisk` and `visibility`: whether the memory can ever be surfaced visibly.
- `validity`: active, stale, contradicted, or uncertain.
- `semanticTags` and `associations`: compact labels that let "not too sweet" connect to "milk tea" or "drinks" without injecting a verbose raw memory.

Old memories may not have these fields, so `selectConstrainedMemoryCues` still has conservative text heuristics as fallback. New distillation paths should fill the metadata when possible. During consolidation, privacy and visibility are merged conservatively: the stricter value wins, and tags/associations are unioned.

## LLM Distillation Contract

LLM distillation improves storage quality, not per-message generation reasoning. It should run asynchronously and produce compact, structured long-term memory candidates.

Distillation must support multiple people and multiple simultaneous memories:

- Split different subject pairs into separate `relationshipImprints`; do not merge them into one broad "everyone started..." summary unless the memory is truly a group-level `objectiveEvent` or `emotionEffect`.
- Fill `subjectIds` with the concrete actor/target ids involved in that memory.
- Keep at most six high-value items per distillation run, with at most two items for the same `subjectIds` combination.
- Mark jokes, tests, temporary exceptions, contradicted claims, and later corrections with `sourceType`, `validity`, or `decision` instead of turning them into stable facts.
- If the model omits metadata, parser defaults are conservative: relationship memories become `target/distilled/pair_private/active` with nonzero privacy risk.

The generation prompt still receives only constrained cues selected from these stored candidates.

## Runtime Flow

1. Coarse retrieval returns a wider candidate set from active and recallable archived memories. This stage may use text, subject ids, semantic tags, and associations.
2. Prompt assembly calls `selectConstrainedMemoryCues` with the current recall cue, channel type, and recently injected memory ids.
3. Only selected constrained cues enter the system prompt. Raw candidate memories do not.
4. Generated message metadata records `runtimeDecision.memoryContext.injectedIds`.
5. Later turns read those recent ids back as `recentMemoryUseIds`, so the same memory is downgraded to `implicit_only` instead of being visibly repeated.

## Test Finding

The stress lab at `tmp/memory-companion-stress-lab-structured/` compared no memory, raw top-5 injection, LLM gate, and LLM gate with extra injection constraints. The important result was not that LLM gate should run synchronously on every message:

- Raw top-N memory injection was the least stable because unrelated but high-salience memories entered the prompt.
- Strict LLM gate was safer than raw injection, but not materially better than a no-memory baseline in average score.
- Extra enforced constraints sometimes made the model underuse useful implicit memory.

For production, the default path should therefore stay cheap and deterministic: local coarse recall, structured metadata, hard privacy/ownership filtering, and 0-3 constrained cues. LLM gate can remain an evaluation tool or future optional enhancement, especially for high-risk memory surfaces.
