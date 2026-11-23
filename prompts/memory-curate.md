[Memory curation] Find entries among the memory facts below that are genuinely semantically duplicated, and propose merges. This is a plain-text analysis task — do not call any tools, do not read files, do not run any operation, and do not answer the conversation itself.

Input: a numbered list of memory facts. The number is only a locator; copy the fact text verbatim, without the number.

{{facts}}

Only merge entries that say the same thing — the same preference, convention or technical decision — in different words. Do NOT merge:
- entries that merely share a topic but carry different information (e.g. "uses pnpm" and "pnpm is pinned to v9");
- an entry that is a more specific or more general version of another when keeping both is not redundant;
- entries that only sound similar but describe different entities, paths, commands or versions.

Output exactly one JSON object — no markdown code fences, no numbering, no explanation. It has exactly one key, merges:

{ "merges": [ { "keep": "<fact text to keep, verbatim>", "absorb": ["<fact text to absorb, verbatim>", ...], "merged": "<the merged replacement text>", "reason": "<short reason>" } ] }

Hard constraints:
- keep and every item of absorb must be copied verbatim from the input list above — no rewording, no added "- " prefix, no punctuation changes;
- absorb has at least one item and must not contain keep;
- merged is a compressed expression of the information in keep and absorb, no longer than the originals combined;
- merged must not introduce any entity, path, command, version number, digit or conclusion that is absent from the originals;
- write merged and reason in the language of the facts;
- when nothing is worth merging, return { "merges": [] }.
