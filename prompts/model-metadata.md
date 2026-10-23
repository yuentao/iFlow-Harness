You are compiling model metadata (context window, input / output price, thinking support) for a coding assistant.
Rules:
- Facts may come only from the [SOURCES] below. Omit any key the sources do not state — never guess, fabricate or fill a number from memory.
- Every entry must carry a source field naming the source id it was read from (e.g. S1). Do not output a model that no source backs.
- name must be copied verbatim from "Model ids in the current API profile" (case and hyphens included). If a source uses another display name (e.g. DeepSeek-V4.1-Flash-1017), still output the id from the request list.
- Output a model only when a source gives at least one concrete number (context window or price). Do not output entries that carry only a name.
- Context window is a token count (1M = 1000000, 384K = 384000).
- Prices are always USD per 1,000,000 tokens. When a source gives CNY or another currency, omit inputPrice / outputPrice and never convert currencies.
- When a model has peak / off-peak or cache-hit tiers, use the standard price: the peak tier for peak / off-peak, the non-hit price for cache.
- supportsThinking only when a source explicitly states thinking support.
- Check context window, input price, output price and thinking support for every model in the list, and fill whatever a source backs.
- At most one entry per model. Output exactly one JSON object: no markdown code fences, no explanation. The object has a single key models, an array whose items look like
  {"name":"deepseek-flash","contextWindow":1000000,"inputPrice":0.15,"outputPrice":0.6,"supportsThinking":true,"source":"S1"}
- No more than {{maxEntries}} entries in total.

Model ids in the current API profile (prefer these):
{{ids}}

[SOURCES]
{{sources}}
