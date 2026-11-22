# 多 Agent / 多子代理系统 Token 开销优化 — 联网调研报告

调研日期：2026-11-22。方法：本机 `curl.exe` / Node `fetch` 直抓一手页面（官方工程博客、官方文档、GitHub API），原文按主题缓存于 `research/_m_*.txt`（Anthropic 博客）与 `research/_p_*.txt`（产品文档 / 开源项目）等文件，每份首行 `/* STATUS: <HTTP码> <最终URL> */` 记录抓取结果。本报告每条要点附可访问 URL（标题 + 大致日期）与「对 iflow-harness Super Agent 的可迁移性」判断。

> 关于用户提到的「单 agent 15k tokens vs 交给 agent 72k tokens」绝对数字：**在本次抓到的一手资料中未能定位到这组绝对值**。Anthropic 原文给的是相对倍数（agent 用 4×、multi-agent 用 15× chat 的 token）与百分比（90.2% 提升、80% 方差解释）；`~72K tokens` 出现在 advanced tool use 文中，指的是「50+ MCP 工具定义的 token 开销」，与「多 agent 总开销」不是同一口径。为避免误引，下文只引用一手原文确有的数字，并单独标注这一缺口。

---

## 0. 速览结论（TL;DR）

- **多 agent 天生烧 token**：Anthropic 实测 multi-agent ≈ 15× chat、单 agent ≈ 4× chat；token 用量本身解释 BrowseComp 80% 的性能方差。「给子代理更多独立上下文去并行烧 token」正是它有效的机理，也是成本根源。
- **最高性价比的四个杠杆**（本仓几乎都能立即做）：① 任务书裁剪 + 规则按需下发；② 子会话工具白名单；③ 汇报只回传 1000–2000 token 的浓缩摘要 / 大产物落盘只回传引用；④ 派发粒度规则化（简单任务 1 个 agent、3–10 次工具调用）。
- **Tool Search / 按需披露是量级最大的单项降本**：工具定义从 ~55K token（58 个工具）降到 ~8.7K（-85%），准确率反而上升。但真正实现需要模型 API 特性（beta `defer_loading`），本仓能用「静态白名单」拿到其中一部分收益。
- **Prompt caching 能省 50%–90% 输入成本**，但依赖网关是否透传 cache 控制字段，属「需实测/可能改协议」的高成本项。
- **子代理隔离上下文已被全行业验证为标准做法**：每个子代理独立系统提示词、独立工具集、独立上下文窗口，只回传摘要——这正是本仓 Super Agent 的既有架构，方向正确，优化重点应放在「下发内容裁剪」和「回传内容收敛」两端。

---

## 1. 多 agent 的 token 开销实测数据（Anthropic 官方工程博客）

来源：《How we built our multi-agent research system》，Anthropic Engineering，**2025-06-13**，
URL：https://www.anthropic.com/research/multi-agent-research-system （本地缓存 `_m_multi_agent.txt`，HTTP 200 全文）。

要点与逐字引用：

1. **token 是性能的主因**：
   > "We found that token usage by itself explains 80% of the variance [in BrowseComp], with the number of tool calls and the model choice as the two other explanatory factors."
   > "a multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval."
   - 迁移性：验证了本仓「多子会话并行扩散 token」的架构价值；但要先保证任务确实可并行（研究/检索类收益最大，强耦合编码类收益小）。

2. **成本赤字的权威表述**：
   > "in practice, these architectures burn through tokens fast. In our data, agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats."
   > "some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today. For instance, most coding tasks involve fewer truly parallelizable tasks than research."
   - 迁移性：诚实提醒——并非所有用户任务都该派子会话；本仓提示词里应保留「仅当任务可并行/信息超出单上下文时才派发」的判据。

3. **派发粒度规则化（可直接写进 system prompt）**：
   > "Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents with clearly divided responsibilities."
   > "Early agents made errors like spawning 50 subagents for simple queries."
   - 迁移性：**低成本、可立即采纳**。把「按任务复杂度决定子会话数与工具调用预算」写进 `prompts/system-prompt.md` 的 Super Agent 段，防止模型过度派发。

4. **并行化提效**：
   > "the lead agent spins up 3-5 subagents in parallel rather than serially; (2) the subagents use 3+ tools in parallel. These changes cut research time by up to 90%"
   - 迁移性：本仓并发池默认 5、FIFO 排队，已对齐；无需改动，可作为「已符合」的正当性引用。

5. **长会话上下文管理**（对应本仓压缩链路）：
   > "agents summarize completed work phases and store essential information in external memory before proceeding to new tasks. When context limits approach, agents can spawn fresh subagents with clean contexts while maintaining continuity through careful handoffs."
   - 迁移性：本仓已有 `/compress` 强制压缩 + 溢出自动压缩 + 内存三纪律（evict/WireRingBuffer/懒挂载），方向一致。

6. **「让子代理直接写文件系统，只回传轻量引用」——Anti–game-of-telephone（本仓最该借鉴的一条）**：
   > "Direct subagent outputs can bypass the main coordinator for certain types of results, improving both fidelity and performance... implement artifact systems where specialized agents can create outputs that persist independently. Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator. This prevents information loss during multi-stage processing and reduces token overhead from copying large outputs through conversation history."
   - 迁移性：**高价值、中等改造量**。本仓子会话汇报目前把结果文本回灌主会话；若改为「大产物落盘（worktree 内文件）→ 只回传路径 + 摘要 + 状态」，可显著降低主会话上下文污染与 token 累积，也让主会话不必重复读大文件。

---

## 2. Context engineering：压缩、按需披露、最小高信号 token（Anthropic 官方工程博客）

来源：《Effective context engineering for AI agents》，Anthropic Engineering，**2025-09-29**，
URL：https://www.anthropic.com/research/effective-context-engineering-for-ai-agents （本地 `_m_context_eng.txt`，HTTP 200 全文）。

1. **总原则**：
   > "good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."
   > "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases."（context rot）
   - 迁移性：作为「为什么要裁剪任务书/工具/schema」的统一理论依据，可直接写进本仓 prompt 注释与设计文档。

2. **Compaction 与「工具结果清理」是最轻的一档压缩**：
   > "Compaction is the practice of taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary."
   > "One of the safest lightest touch forms of compaction is tool result clearing — once a tool has been called deep in the message history, why would the agent need to see the raw result again?"
   - 迁移性：**低成本/中成本**。本仓 webview 已有 `evictBlockPayloads` 淘汰旧块 payload（保留窗口外标「内容已释放」），是同一思想；可进一步在 host 侧对「深层已消费的工具结果」做摘要替代原文，但要守住「host 全量保真、只裁 webview」的既有纪律。

3. **子代理只回传浓缩摘要（本仓汇报契约的权威背书）**：
   > "Each subagent might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)."
   > "the detailed search context remains isolated within sub-agents, while the lead agent focuses on synthesizing and analyzing the results."
   - 迁移性：**直接采纳**。为本仓 `super-agent-task.md` 的「汇报格式约束」提供量化目标（1000–2000 token），并作为「汇报只回传增量不累积」的强依据——回传的是摘要，不是全量历史。

4. **Just-in-time 上下文 / progressive disclosure**：
   > "maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools... Agents can assemble understanding layer by layer, maintaining only what's necessary in working memory."
   - 迁移性：**低成本**。任务书里用 `@文件路径` 引用而不是把规则正文/SKILL 全文塞进每个子会话；本仓 `/skill` 注入逻辑已具备「Base directory + SKILL.md 正文 + 用户指令」能力，可评估对子会话是否按需注入而非全量注入。

---

## 3. Prompt caching：机制、计费规则、breakpoint 位置（Anthropic / OpenAI / Claude Code 文档）

### 3.1 Anthropic Prompt Caching

来源：《Prompt caching with Claude》，Anthropic/Claude，**页面日期 2025-08-14**（正文含 GA 更新 2024-12-17），URL：https://claude.com/resources/articles/prompt-caching （本地 `_p_anthropic_caching_blog.txt`，HTTP 200 全文）。

> "reducing costs by up to 90% and latency by up to 85% for long prompts."
> "Writing to the cache costs 25% more than our base input token price for any given model, while using cached content is significantly cheaper, costing only 10% of the base input token price."
> 价格示例 Sonnet：Input $3/MTok、Cache write $3.75/MTok、Cache read $0.30/MTok；Opus $15 / $18.75 / $1.50。
> 表格实测："Chat with a book (100,000 token cached prompt) 11.5s → 2.4s (-79%), -90%"；"Multi-turn conversation 10s → 2.5s (-75%), -53%"。
> 适用场景明确包含 "Agentic search and tool use... where each step typically requires a new API call."

- 迁移性：**高价值但需验证网关**。本仓 Super Agent 每轮主/子会话重复带同一 system prompt + 工具 schema（实测单次平凡 prompt 就 ~56K tokens 固定输入），是 caching 的理想负载。但本仓走 OpenAI-compatible 网关，需先探测是否透传 cache 字段（见 §3.4）。

### 3.2 OpenAI Automatic Prompt Caching

来源：《Prompt Caching in the API》，OpenAI，**2024-10-01**，URL：https://openai.com/index/api-prompt-caching/ （本地 `_p_openai_caching.txt`，HTTP 200 全文）。

> "By reusing recently seen input tokens, developers can get a 50% discount and faster prompt processing times."
> "automatically applied on prompts longer than 1,024 tokens. The API caches the longest prefix of a prompt that has been previously computed, starting at 1,024 tokens and increasing in 128-token increments."
> "Requests using Prompt Caching have a cached_tokens value within the usage field in the API response."（示例 `"prompt_tokens_details": {"cached_tokens": 1920}`）
> "Caches are typically cleared after 5-10 minutes of inactivity and are always removed within one hour of the cache's last use. Prompt caches are not shared between organizations."
> 价格示例 GPT-4o：$2.50 uncached → $1.25 cached。

- 迁移性：**机制说明价值高、落地需网关支持**。关键点：OpenAI 是「自动、最长前缀、无需改代码」，只要保证 system prompt + 工具定义的字节级稳定就能吃到折扣；这提示本仓应把「每轮变化的时间戳/git status」挪到提示词尾部，别放在稳定前缀里（breakpoint 位置原则）。

### 3.3 Claude Code 的缓存实践（breakpoint / TTL 的实锤）

来源：《Prompt caching》Claude Code Docs，URL：https://code.claude.com/docs/en/prompt-caching ；《Context window》URL：https://code.claude.com/docs/en/context-window （本地 `_p_cc_caching.txt` 174KB / `_p_cc_context.txt` 142KB，HTTP 200 全文；文档页无单一发布日期，按内容属 2026 现行版）。

> "The API offers two: a five-minute TTL, and a one-hour TTL that keeps the cache warm through longer breaks but charges a higher rate for cache writes."
> "Claude Code reports one-hour cache writes under ephemeral_1h_input_tokens and five-minute cache writes under ephemeral_5m_input_tokens."（对应 Anthropic API 的 `cache_creation_input_tokens` / `cache_control: ephemeral` 计费维度；可用 `claude -p "hello" --output-format json` 查看 `usage.cache_creation` 核验）
> "Tool definitions sit in the system prompt layer, so the cache invalidates when the set of tool definitions in the request changes between turns. Toggling the advisor tool is an exception: its definition sits after the cache breakpoint, so enabling or disabling /advisor keeps the cached prefix intact."
> "Each model has its own cache. Switching with /model means the next request reads the entire conversation history with no cache hits."
> "changing the effort level mid-session means the next request reads the entire conversation history with no cache hits."

- **breakpoint 位置原则（可操作结论）**：把「稳定不变的系统提示词 + 核心工具定义」放在缓存前缀（breakpoint 之前），把「易变部分（当前轮输入、动态注入的 git status/时间、可开关的工具）」放在 breakpoint 之后；任何工具定义集合变动、模型切换、effort 切换都会使缓存失效。
- 迁移性：**思路可立即采纳，特性需网关支持**。本仓可在不依赖网关的情况下先做「稳定前缀」改造（把动态内容后置），为将来网关支持 caching 时零成本吃到折扣铺路；`cache_control: ephemeral` / `cached_tokens` 字段是否可用须先用真实 API 实测（本仓约定：涉及接口/消耗必须实测，禁止猜测）。

### 3.4 Gemini Context Caching — 本轮未能一手核实

- 官方 URL（供主会话/browser 侧访问）：https://ai.google.dev/gemini-api/docs/caching
- 本机抓取状态：`ai.google.dev` 多次 `fetch failed`，`curl.exe` 返回 `HTTP:000 SIZE:0`（网络对该域名不可达）；Bing 搜索页能返回（`cn.bing.com` HTTP 200，本地 `_bing_gemini_cache.html`），但未拿到官方正文，**故本报告不引用其具体 token 阈值/TTL/折扣数字，避免编造**。

---

## 4. 工具 schema 本身就占大量 token：按需披露工具（Anthropic 官方工程博客）

来源：《Introducing advanced tool use on the Claude Developer Platform》，Anthropic Engineering，**2025-11-24**，URL：https://www.anthropic.com/research/advanced-tool-use （本地 `_m_adv_tool_use.txt`，HTTP 200 全文）。另参 MCP 社区工具搜索讨论（GitHub issues API，本地 `_mcp_toolsearch_issues.txt`）：https://api.github.com/search/issues?q=repo:modelcontextprotocol/modelcontextprotocol+tool+search+in:title,body

1. **工具定义吃掉的 token 是量级问题**：
   > "tool results and definitions can sometimes consume 50,000+ tokens before an agent reads a request."
   > "GitHub: 35 tools (~26K tokens), Slack: 11 tools (~21K tokens), Sentry 5 (~3K), Grafana 5 (~3K), Splunk 2 (~2K) — that's 58 tools consuming approximately 55K tokens before the conversation even starts. Add Jira (which alone uses ~17K tokens) and you're quickly approaching 100K+ token overhead. At Anthropic, we've seen tool definitions consume 134K tokens before optimization."（注意：这里的 ~72K/~134K 指工具定义，不是多 agent 总开销）

2. **Tool Search Tool = 按需披露（本主题核心）**：
   > "Instead of loading all tool definitions upfront, the Tool Search Tool discovers tools on-demand. Claude only sees the tools it actually needs for the current task."
   > "Only the Tool Search Tool loaded upfront (~500 tokens)... Total context consumption: ~8.7K tokens, preserving 95% of context window. This represents an 85% reduction in token usage."
   > "Opus 4 improved from 49% to 74%, and Opus 4.5 improved from 79.5% to 88.1% with Tool Search Tool enabled."
   > "mark tools with defer_loading: true to make them discoverable on-demand... keep your three to five most-used tools always loaded, defer the rest."
   > "Prompt caching note: Tool Search Tool doesn't break prompt caching because deferred tools are excluded from the initial prompt entirely."
   - 适用门槛（原文）："Tool definitions consuming >10K tokens"、"10+ tools available"。beta header：`advanced-tool-use-2025-11-20`。
   - 迁移性：**方向最高价值、完整实现需模型特性**。本仓主会话已用 `settings.allowed_tools` 白名单（仅放行 `super-agent`/`todo`/`ask_user_question`）+ 进程级 MCP 哨兵把工具面砍到极小，等价于「手工写死的三五个常驻工具」，已拿到按需披露的大部分收益；子会话刻意保留全量工具，若要进一步降本，可评估「按任务类别给子会话不同 allowed_tools 白名单」（低成本改造）。

3. **Programmatic Tool Calling（用代码编排工具，中间结果不入上下文）**：
   > "Average usage dropped from 43,588 to 27,297 tokens, a 37% reduction on complex research tasks... reducing consumption from 200KB of raw expense data to just 1KB of results."
   - 迁移性：本仓 ACP 工具由 CLI 执行、宿主拿不到代码执行沙箱，短期不可迁移；但「别把中间工具输出全量回灌上下文」的思想已体现在本仓 `evictBlockPayloads` 与「工具结果清理」中。

4. **Tool Use Examples（示例补 schema 的表达力，72% → 90% 参数正确率）**：
   > "tool use examples improved accuracy from 72% to 90% on complex parameter handling."
   - 迁移性：偏向准确率而非纯 token 节省；本仓工具描述已由 CLI 内置，改造点不在宿主侧。

---

## 5. 子代理隔离上下文的实践（Anthropic / Claude Code / OpenAI）

1. **Anthropic multi-agent（已于 §1 引用）**：每个子代理 "operating in parallel with their own context windows... distinct tools, prompts, and exploration trajectories"，本质是「独立上下文 + 只回传压缩结果」。

2. **Claude Code Sub-agents 官方文档**，URL：https://code.claude.com/docs/en/sub-agents （本地 `_p_cc_subagents.txt` 442KB，HTTP 200 全文）：
   > "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions."
   > "Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history, the skills you've already invoked, or the files Claude has already read. Claude composes a delegation message that summarizes the task, and the subagent works from there."
   - **规则裁剪的直接证据**：
   > "Those descriptions take up context, so keep them short. When the combined descriptions of your subagents... exceed 15,000 tokens, Claude Code shows a warning at startup... Trim the description fields of your subagents, and move detail into each subagent's system prompt, which only loads when that subagent runs."
   > "CLAUDE.md files: every level of the CLAUDE.md hierarchy the main conversation loads... The built-in Explore, Plan, and web-fetch agents skip this. A subagent whose definition sets omitClaudeMd loads only the managed policy files."
   > "The main conversation still has your full CLAUDE.md when it reads these subagents' results, so most rules don't need to reach the subagent itself. If a rule must, such as 'ignore the vendor/ directory,' restate it in the prompt you give Claude when delegating."
   - **工具白名单**：built-in 子代理 "most run with a restricted tool set"，Explore/Plan "read-only tools; Write and Edit are denied"；frontmatter 字段含 `tools` / `disallowedTools` / `maxTurns` / `autoCompactWindow` / `omitClaudeMd` / `isolation`。
   > "Running many subagents that each return detailed results can consume significant context, and each subagent spends tokens of its own while it runs."
   - 迁移性：**逐条高度可迁移**。① "omitClaudeMd" 直接对应本仓「任务书裁剪掉与子任务无关的规则」——应让子会话只加载与其子任务相关的规则切片，而非整份 `AGENTS.md`；② "restate the rule when delegating" 对应「把必要规则显式写进任务书」；③ 工具白名单对应本仓子会话当前全量工具的收敛改造；④ `maxTurns`/`autoCompactWindow` 对应本仓缺失的「子会话级 token/轮次预算」——值得新增。

3. **OpenAI Swarm / Agents SDK**，URL：https://github.com/openai/swarm/blob/main/README.md （本地 `_p_swarm2.txt` 为 GitHub API base64 README）；SDK 文档 https://openai.github.io/openai-agents-python/ （本地 `_p_oai_agents.txt`，HTTP 200）：
   > README 明确 "Swarm is now replaced by the OpenAI Agents SDK, which is a production-ready evolution of Swarm... Swarm focuses on making agent coordination and execution lightweight, highly controllable, and easily testable."；每个 Agent 仅由 `instructions` + `functions` 定义，上下文通过 handoff / 函数返回值在 agent 间显式传递。
   - 迁移性：印证「最小 agent 定义 + 显式上下文传递」的社区共识；本仓委派指令（代码块/task 工具）已是同类「轻量交接」形态。

4. **Claude Code Agent Teams**，URL：https://code.claude.com/docs/en/agent-teams （本地 `_p_cc_teams.txt` 189KB，HTTP 200）：团队/队友各自独立上下文与消息通道（SendMessage / sibling roster），与本仓看板 + 汇报车道同构，可作为「多 agent 编排的产品化参照」。

---

## 6. 其它开源实践：压缩、任务分解、token 预算

1. **aider（repo map + 模型分工 + 历史预算）**，官方文档 URL：https://aider.chat/docs/config/options.html （本地 `_p_aider_options2.txt`，HTTP 200）；FAQ https://aider.chat/docs/faq.html ：
   > `--weak-model WEAK_MODEL`："Specify the model to use for commit messages and chat history summarization (default depends on --model)" —— 用便宜小模型做提交信息与聊天历史摘要；`--editor-model` 用另一模型做编辑；`--max-chat-history-tokens VALUE` 限制聊天历史 token；repo map 用 tree-sitter 生成代码地图（"Add language support via tree-sitter-language-pack"），并指出 "Depending on the LLM you are using, aider may launch with the repo map disabled by default... The repo map is usually disabled for a good reason."（避免模型误把 repo map 当真实代码编辑）
   - 迁移性：**低成本思想可借鉴**：用「小模型/直连轻量调用」做子会话汇报的二次浓缩（本仓已有 `streamChatCompletion` 直连通道与内部 prompt 体系，可复用）；`max-chat-history-tokens` 对应「给子会话设 token 预算上限」。

2. **LangChain / LangGraph middleware**，URL：https://docs.langchain.com/oss/python/langchain/middleware/overview （本地 `_p_langchain_mw.txt` 306KB，HTTP 200）：提供 `SummarizationMiddleware`、`HumanInTheLoopMiddleware`、LLM-based `tool selection` 等中间件，把「摘要压缩 / 审批 / 工具选择」做成可插拔层。
   > 文档原文列出 "HITL interrupt, summarization, PII redaction, retries, and any custom hooks"，以及 `/oss/python/langchain/middleware/built-in#llm-tool-selector` 的工具选择能力。
   - 迁移性：架构思想（把压缩/工具选择做成 middleware 层）与本仓 `src/acp/`、`shared/` 下沉纯逻辑的纪律一致；`SummarizationMiddleware` 对应本仓压缩链路，`LLM tool selector` 对应 §4 按需披露。注：旧 LangGraph `add-summary` how-to 已迁移（本地抓取 404），以新文档为准。

3. **claude-flow 等社区编排项目**：GitHub 仓库搜索（本地 `_p_claudeflow_search.txt`）：https://api.github.com/search/repositories?q=claude-flow —— 属社区实验性编排，权威性与一手数字弱于上述官方文档，本报告不作为关键数字来源，仅作生态参考。

---

## 7. 落地分类：只改提示词/调度层（低成本、本仓可立即采纳） vs 改协议/换模型特性（高成本）

### A. 低成本（提示词 / 调度层，无需改协议）

1. **任务书裁剪 + 规则按需下发**（§2.4、§5.2）：子会话只加载与子任务相关的规则切片（类比 `omitClaudeMd`），把必要约束显式重述进任务书，不要把整份 AGENTS.md/SKILL 全量塞给每个子代理。→ 本仓 `prompts/super-agent-task.md` 与委派提示词拼装处可改。
2. **子会话工具白名单**（§4.2、§5.2）：按任务类别给子会话不同的 `allowed_tools` 子集；主会话已用白名单 + MCP 哨兵，子会话是全量工具的缺口，改造成本低、收益直接（工具 schema 是 token 大头）。
3. **汇报只回传增量、不累积**（§1.6、§2.3）：把「大产物落盘 → 只回传路径 + 1000–2000 token 摘要 + 状态」写进汇报契约；`SuperReportBuffer` 已按子会话去重、逐条即时交付，方向正确，需强化「摘要而非全量」的格式约束。
4. **派发粒度规则化**（§1.3）：把「简单 1 agent/3–10 calls；中等 2–4 agent/10–15 calls；复杂才 10+」写进主会话 system prompt，防「50 subagents for simple queries」。
5. **稳定前缀改造**（§3.3）：把每轮变化的动态内容（git status、时间、会话元信息）从系统提示词前缀移到尾部；无需网关支持即可减少未来的 caching 失效面。
6. **token 预算字段**（§5.2、§6.1）：借鉴 `maxTurns`/`autoCompactWindow`/`--max-chat-history-tokens`，给子会话设轮次/token 上限与自动压缩阈值（本仓 `iflow.superAgent.*` 设置可扩展）。
7. **工具结果清理 / 摘要替代**（§2.2）：对深层已消费的工具输出用摘要替代原文，守住「host 全量保真、webview 裁剪」的既有纪律。

### B. 高成本（改协议 / 换模型特性 / 依赖网关）

1. **Prompt caching 真正落地**（§3）：需模型/网关透传 `cache_control: ephemeral`、`cached_tokens`、`cache_creation_input_tokens` 及 5m/1h TTL。本仓走 OpenAI-compatible 网关，**必须先用真实 API 实测**（本仓硬性约定），不实测不得下结论。
2. **Tool Search Tool / `defer_loading` / Programmatic Tool Calling**（§4.2/4.3）：Anthropic beta `advanced-tool-use-2025-11-20`，属模型 API 特性；本仓 CLI fork 与网关是否支持需另行调研，短期只能靠静态白名单拿到部分收益。
3. **真正的按需工具发现协议**（§4）：要在 ACP 层实现工具的动态注册/发现（而非启动期静态 `allowed_tools`），改动协议与 CLI 内核，成本高。
4. **子会话级独立上下文压缩与更小窗口模型**（§5.2）：`isolation`/按子任务换小窗口模型需要 CLI `session/new` 支持相应 settings，属内核能力扩展。

---

## 8. 资料可靠性与未能访问项（如实声明）

- HTTP 200 一手全文：Anthropic 三篇博客（multi-agent / context engineering / advanced tool use）、Anthropic prompt caching 文章、OpenAI prompt caching 文章、Claude Code docs（sub-agents / agent-teams / context-window / prompt-caching / costs）、LangChain middleware docs、aider options/FAQ、OpenAI Agents SDK 文档、MCP/claude-flow GitHub API 结果。
- 区域限制/失败项（不引用其数字）：`claude.com/app-unavailable-in-region`（`_p_anthropic_caching*`、`_p_tool_search*`，但同名主题已由 `claude.com/resources/articles/prompt-caching` 官方文章覆盖）；Gemini 官方文档（`ai.google.dev` 全数失败）；Swarm README 本体走 GitHub API base64 取得（可读）；旧 LangGraph `add-summary` how-to 404（已以新文档替代）。
- 「单 agent 15k vs 多 agent 72k」绝对数字未能在一手资料核实，未编造；如主会话需要该数字，请提供出处或允许再次定向检索。

---

## 9. 对 iflow-harness Super Agent 的逐条迁移建议（对应任务特别关注项）

| 关注项 | 结论 | 来源依据 | 成本档 |
| --- | --- | --- | --- |
| 子会话工具白名单 | 采纳：按任务类别给子会话 `allowed_tools` 子集，改当前「全量工具」 | §4.2 §5.2 | 低 |
| 按需披露工具 | 方向采纳；完整实现依赖模型 beta，本仓靠静态白名单近似 | §4.2 | 低（近似）/ 高（完整） |
| prompt caching breakpoint 位置 | 先做「稳定前缀、动态内容后置」，字段支持待实测 | §3.1–3.4 | 低（改造）/ 高（特性） |
| 汇报只回传增量不累积 | 采纳：落盘 + 1000–2000 token 摘要 + 引用回传，强化汇报契约 | §1.6 §2.3 | 低 |
| 任务书裁剪无关规则 | 采纳：类比 `omitClaudeMd`，只下发相关规则切片，必要规则显式重述 | §2.4 §5.2 | 低 |
