/**
 * 超流体（子会话）独立 API 配置与模型解析 —— 纯逻辑，零 VSCode / 零 IO 依赖。
 *
 * 动因：今天主会话与超流体虽然进程隔离，但**凭据与模型来自同一处** ——
 * 子会话 spawn 时先解析工作区握手凭据，缺失时回退到已加载凭据；模型取自主
 * 会话 store 的 `currentModelId`。于是「主会话切 Profile / 模型」会连带改掉
 * 新派发子会话的配置，无法做到「主用一个网关、超流体用另一个网关」。
 *
 * 两条链路的分工（方案文档 §1.3）：
 *  - **共用 Profile 定义，不共用活动指针**：两条链路从同一份 Profile 库
 *    （SecretStorage `iflow.profiles` + 内核 `apiProfiles`）按名取
 *    baseUrl / apiKey / modelName，但各自记住「我当前用哪个」。本模块因此只
 *    接收「指针名」与「Profile 库」，不碰 SecretStorage / 内核 settings ——
 *    那些是宿主的活（读写纪律见 `src/panel/settings-write-service.ts`）。
 *  - **不新增凭据存储**：本模块不新增任何 SecretStorage key，也不写盘。
 *
 * 解析链（方案文档 §3.1 / §3.2）：
 *
 *   端点（baseUrl + apiKey + Profile 自带模型名）
 *     1. 任务级 profileId              —— 单次任务临时覆盖
 *     2. `iflow.superAgentProfile`      —— 超流体链路独立指针
 *     3. `iflow.workspaceActiveProfile` —— 主链路活动指针
 *     4. 活动凭据（`loadCredentials`）  —— workspaceState 缺失时先回退到这里
 *     5. 内核 `currentApiProfile`（具名）→ 内核**顶层默认** —— 以上都不可用
 *        时再回退。顶层默认没有 Profile 名，宿主用 `readActiveEndpoint()` 的
 *        结果填 `kernelDefaultEndpoint`（它已把「具名 Profile → 顶层
 *        baseUrl/apiKey」逐字段合并完）。
 *
 *   **④⑤ 的顺序必须与子会话实际握手路径一致**：`createSuperClient` 解析凭据走
 *   `resolveWorkspaceHandshakeCreds() ?? loadCredentials(secrets)`（见
 *   `src/panel/super-agent-host.ts:1936-1944`），`resolveSuperProfileTarget` 再补
 *   `?? readActiveEndpoint()`（`src/panel/panel.ts:9697-9698`）。也就是说工作区
 *   指针之后**先**回退到 SecretStorage 活动凭据槽（`loadCredentials`），**最后**
 *   才轮到内核 `currentApiProfile` / 内核默认。把内核指针提到活动凭据之前会让
 *   「未配置超流体」时解析出与今天不同的端点。
 *
 *   模型
 *     1. 任务级 modelId
 *     2. `iflow.superAgentModel`
 *     3. 目标 Profile 的 modelName
 *     4. 主 store 的 currentModelId
 *
 * 防误伤纪律（AGENTS.md 陷阱 #25）：**空的 / 失败的 live /models 查询不构成
 * 模型下架证据** —— 端点挂了 ≠ 模型没了。只有「live 列表非空、且确实不含目标
 * 模型」才敢降级；降级也是显式的（带原因），绝不静默换一个模型。
 *
 * 取舍（文档未写死的细节，均在下方代码注释里标了依据）：
 *  - 指针指向**不存在的 Profile** 时**继续往下回退**，而不是报错中断：一次
 *    任务级的临时覆盖写错名字，不该让整条超流体链路瘫掉（与「回退链」的
 *    语义一致）。
 *  - 模型降级时**先在链上更低的候选里找**一个仍存在于 live 列表的，都不行才
 *    用 live 列表的首个模型兜底（与主会话 `validateModelForPush` 的
 *    `cliModelId ?? live[0].id` 同款兜底，只是这里多了「链上候选」一层）。
 *  - 四级候选全空（连主会话当前模型都没有）时**不编造模型**：返回
 *    `modelId: null`，由调用方决定不推 `set_model`。
 *
 * ── 宿主接线契约（**接线前必读**，否则「未配置超流体时行为与今天一致」这条
 * 硬要求会被打破）────────────────────────────────────────────────────────
 *
 *  1. **Profile 库的合并口径**：同名 Profile 冲突时**内核 `apiProfiles` 优先**，
 *     SecretStorage `iflow.profiles` 次之 —— 与握手路径
 *     `resolveWorkspaceHandshakeCreds`（`src/panel/panel.ts:7199`）的
 *     `kernelProfileCredentials(name) ?? profiles[name]` 完全同序。宿主若反过来
 *     合并，第 3 级会解析出**与握手路径不同的凭据**。
 *  2. **第 4/5 级装什么**：第 4 级装握手路径调用点的下一级（SecretStorage
 *     `iflow.openai-compatible` 活动凭据槽，即 `loadCredentials(secrets)`）；
 *     第 5 级才是内核 `currentApiProfile` / 内核顶层默认（`readActiveEndpoint()`
 *     的后半段），是最后兜底 —— 只在工作区指针与活动凭据都不可用时生效。顺序
 *     颠倒会与握手路径分叉。第 5 级由两个输入表达：`kernelProfileName`
 *     （具名内核指针）与 `kernelDefaultEndpoint`（`readActiveEndpoint()` 合成
 *     出的内核顶层默认）。后者**不能省**：只有顶层 baseUrl/apiKey、没有任何
 *     Profile 时，缺了它整条链会错误地返回 null。
 *  3. **模型的「跟随主链路」语义**：见 {@link resolveSuperApiSpec} 的
 *     `profileModelName: null` 说明 —— 想让子会话沿用**主会话当前模型**（今天
 *     的实际取值）而不是主链路 Profile 的默认模型名，必须显式传 `null`。
 */

/** 一组 API 连接参数（Profile 本体：baseUrl / apiKey / modelName）。 */
export interface SuperApiProfile {
  baseUrl: string;
  apiKey: string;
  /** Profile 自带的模型名；null = 该 Profile 不指定模型。 */
  modelName: string | null;
}

/** 端点解析命中了链上的哪一级（由高到低）。 */
export type SuperEndpointSource =
  /** 任务级 profileId 覆盖。 */
  | "task-profile"
  /** `iflow.superAgentProfile`（超流体链路独立指针）。 */
  | "super-profile"
  /** `iflow.workspaceActiveProfile`（主链路活动指针）。 */
  | "main-profile"
  /** 活动凭据（`iflow.openai-compatible`，握手路径的下一级 `loadCredentials`）。 */
  | "active-credentials"
  /** 内核 `currentApiProfile`（具名 Profile，最后兜底的第一小步）。 */
  | "kernel-profile"
  /**
   * 内核**顶层默认**（`settings.json` 顶层 `baseUrl` / `apiKey`，没有任何
   * Profile 名可指向）。对应 `readActiveEndpoint()` 的后半段：`currentApiProfile`
   * 为空或该 Profile 不完整时，内核逐字段回退到顶层配置。
   */
  | "kernel-default";

/** {@link resolveSuperEndpoint} 的入参（全部由宿主喂进来，本模块不读盘）。 */
export interface SuperEndpointInput {
  /**
   * 任务级临时覆盖（`SuperTaskSpec.profileId`）。
   * 优先于超流体链路指针；指向不存在的 Profile 时继续往下回退。
   */
  taskProfileId?: string | null;
  /** 超流体链路独立指针 `iflow.superAgentProfile`（值为 Profile 名）。 */
  superProfileName?: string | null;
  /** 主链路活动指针 `iflow.workspaceActiveProfile`（workspaceState）。 */
  mainProfileName?: string | null;
  /** 内核 `currentApiProfile` / 内核默认（最后兜底：工作区指针与活动凭据都不可用时）。 */
  kernelProfileName?: string | null;
  /**
   * 内核**顶层默认**端点（`settings.json` 顶层的 `baseUrl` / `apiKey`，
   * 没有任何 Profile 名）。
   *
   * 为什么需要它：`kernelProfileName` 只能表达「内核指针指向某个具名
   * Profile」；今天 `readActiveEndpoint()` 在 `currentApiProfile` 为空（或该
   * Profile 缺字段）时会逐字段回退到顶层 `baseUrl` / `apiKey` —— 那一档
   * **没有名字**，纯函数原先把这种情况表达成「什么都没有」，与握手路径分叉。
   *
   * 宿主按 `readActiveEndpoint()` 的结果喂进来即可：它已经把「具名内核
   * Profile → 顶层配置」的逐字段合并做完了（`src/acp/models-query.ts`）。
   * 顺序：具名内核指针（`kernelProfileName`）**先**，本字段**后** —— 与
   * `readActiveEndpoint()` 的 `active?.baseUrl ?? settings.baseUrl` 同序。
   */
  kernelDefaultEndpoint?: SuperApiProfile | null;
  /**
   * 具名 Profile 库（宿主把 SecretStorage 与内核 `apiProfiles` 合并后的结果）。
   *
   * **合并口径由宿主决定，且必须与握手路径一致**：同名 Profile 冲突时
   * **内核 `apiProfiles` 优先**、SecretStorage `iflow.profiles` 次之 —— 与
   * `resolveWorkspaceHandshakeCreds` 的 `kernelProfileCredentials(name) ??
   * profiles[name]` 同序。宿主若反过来合并，第 3 级会解析出与握手路径不同的
   * 凭据，「未配置超流体时行为与今天一致」当场破掉。
   */
  profiles?: Readonly<Record<string, SuperApiProfile>> | null;
  /**
   * 活动凭据（握手路径工作区指针之后的下一级：SecretStorage
   * `iflow.openai-compatible`，即 `loadCredentials(secrets)`）。
   *
   * 宿主应按子会话握手调用点同口径装入该槽（`src/panel/super-agent-host.ts`
   * 的 `resolveWorkspaceHandshakeCreds() ?? loadCredentials(secrets)`）。它会
   * **先于**内核 `currentApiProfile` 命中 —— 顺序与今天子会话的凭据解析一致，
   * 否则「未配置超流体时行为与今天不同」。
   */
  activeCredentials?: SuperApiProfile | null;
}

/** 解析出来的端点：一次 `authenticate` 推送需要的三项。 */
export interface SuperEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Profile 自带的模型名（null = 该 Profile 不指定模型，模型另由模型链决定）。 */
  modelName: string | null;
  /** 命中了链上的哪一级。 */
  source: SuperEndpointSource;
  /**
   * 命中的**管理名**（真正决定凭据的具名 Profile）。活动凭据
   * （`active-credentials`）与内核顶层默认（`kernel-default`）这两种来源
   * 没有具名 Profile，为 null —— 设置页需要的**展示名**由宿主另算，不要
   * 拿这个字段冒充（两者不同源）。
   */
  profileName: string | null;
}

/**
 * 把任意来源的 modelName 归一成「非空字符串或 null」。
 *
 * 为什么要 typeof 守卫：`baseUrl` / `apiKey` 都被守卫了，唯独 `modelName`
 * 没有 —— 而宿主的 Profile 库可能来自**未经字段过滤**的原始 JSON
 * （`readActiveEndpoint` 就不过滤：一个只有 `baseUrl` 没有 `apiKey` 的残缺
 * profile 仍会贡献字段）。一个 `modelName: 123` 会让 `modelName.trim()`
 * 直接抛 TypeError，把一次「解析配置」变成一次崩溃。
 */
function normalizeModelName(raw: unknown): string | null {
  return typeof raw === "string" ? raw.trim() || null : null;
}

/**
 * 把 live `/models` 的返回归一成「非空、去重、trim 过的模型 id 列表」。
 *
 * 两点纪律：
 *  - **空白 id 不算一个「存在的模型」**：live 列表里混进空串时，它既不该
 *    命中目标模型，也不该成为兜底模型（推一个空模型 id 等于没推）。
 *  - **归一后为空 = 查询失败 / 空列表** ⇒ 不构成下架证据（与 `[]` 同义）。
 */
function normalizeLiveModelIds(raw: readonly string[] | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 按优先级链解析超流体子会话该用的端点 / 凭据来源。
 *
 * 返回 null = 一份可用凭据都没有（宿主据此不推 `authenticate`，沿用 CLI 自身
 * 的启动配置）。**未配置超流体链路时必然落回主链路**（第 3 / 4 级），因此老
 * 用户零配置零行为变化。
 *
 * 与握手路径的对应关系（供接线核对）：
 *  - 第 3 级与 `resolveWorkspaceHandshakeCreds`（`src/panel/panel.ts:7199`）
 *    **同源**：同一个 workspaceState 键（`iflow.workspaceActiveProfile`）、
 *    同一种「内核 `apiProfiles` 优先」的 Profile 查找口径。
 *  - 第 4 级 = 该函数**调用点**的下一级 `loadCredentials(secrets)`：子会话实际
 *    凭据链是 `resolveWorkspaceHandshakeCreds() ?? loadCredentials()`（见
 *    `src/panel/super-agent-host.ts:1936-1944`）。
 *  - 第 5 级 = 内核 `currentApiProfile` / 内核默认，对应面板
 *    `resolveSuperProfileTarget` 的 `?? readActiveEndpoint()` 兜底，最后生效。
 *    把这一级提到第 4 级之前会与上面的实际链分叉。
 */
export function resolveSuperEndpoint(input: SuperEndpointInput): SuperEndpoint | null {
  const profiles = input.profiles ?? {};
  // ①②③ 链上的具名 Profile 指针（顺序即优先级）。内核 currentApiProfile 不在
  // 这里 —— 它是最后一档，排在「活动凭据」之后（与子会话握手路径一致）。
  const named: Array<{ name: string | null | undefined; source: SuperEndpointSource }> = [
    { name: input.taskProfileId, source: "task-profile" },
    { name: input.superProfileName, source: "super-profile" },
    { name: input.mainProfileName, source: "main-profile" },
  ];
  const fromProfile = (
    name: string | null | undefined,
    source: SuperEndpointSource,
  ): SuperEndpoint | null => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return null;
    const profile = profiles[trimmed];
    // 指针指向的 Profile 不存在 / 不完整 → 继续往下回退（见文件头取舍说明）。
    if (!profile) return null;
    const baseUrl = typeof profile.baseUrl === "string" ? profile.baseUrl.trim() : "";
    const apiKey = typeof profile.apiKey === "string" ? profile.apiKey.trim() : "";
    if (!baseUrl || !apiKey) return null;
    return {
      baseUrl,
      apiKey,
      modelName: normalizeModelName(profile.modelName),
      source,
      profileName: trimmed,
    };
  };
  for (const candidate of named) {
    const hit = fromProfile(candidate.name, candidate.source);
    if (hit) return hit;
  }
  // 第 4 级：活动凭据（握手路径工作区指针之后的下一级 `loadCredentials`）。
  // 必须先于内核 currentApiProfile —— 今天子会话的凭据就取自这一槽。
  const active = input.activeCredentials;
  if (active) {
    const baseUrl = typeof active.baseUrl === "string" ? active.baseUrl.trim() : "";
    const apiKey = typeof active.apiKey === "string" ? active.apiKey.trim() : "";
    if (baseUrl && apiKey) {
      return {
        baseUrl,
        apiKey,
        modelName: normalizeModelName(active.modelName),
        source: "active-credentials",
        profileName: null,
      };
    }
  }
  // 第 5 级：内核 currentApiProfile（具名 Profile）。
  const kernelNamed = fromProfile(input.kernelProfileName, "kernel-profile");
  if (kernelNamed) return kernelNamed;
  // 5b：内核**顶层默认** —— 没有任何 Profile 名可指的那一档。今天
  // `readActiveEndpoint()` 在 currentApiProfile 为空（或该 Profile 不完整）
  // 时逐字段回退到 settings 顶层 baseUrl / apiKey；没有这个输入时纯函数只能
  // 返回 null，与握手路径分叉。宿主把 `readActiveEndpoint()` 的结果喂进来。
  const kernelDefault = input.kernelDefaultEndpoint;
  if (kernelDefault) {
    const baseUrl =
      typeof kernelDefault.baseUrl === "string" ? kernelDefault.baseUrl.trim() : "";
    const apiKey = typeof kernelDefault.apiKey === "string" ? kernelDefault.apiKey.trim() : "";
    if (baseUrl && apiKey) {
      return {
        baseUrl,
        apiKey,
        modelName: normalizeModelName(kernelDefault.modelName),
        source: "kernel-default",
        profileName: null,
      };
    }
  }
  return null;
}

/** 模型解析命中了链上的哪一级（由高到低），或降级兜底。 */
export type SuperModelSource =
  /** 任务级 modelId 覆盖。 */
  | "task-model"
  /** `iflow.superAgentModel`（超流体链路独立模型）。 */
  | "super-model"
  /** 目标 Profile 自带的 modelName。 */
  | "profile-model"
  /** 主 store 的 currentModelId（最终回退）。 */
  | "main-model"
  /** 降级兜底：链上候选都不在 live 列表里，用 live 列表首个模型。 */
  | "live-fallback";

/** {@link resolveSuperModel} 的入参。 */
export interface SuperModelInput {
  /** 任务级临时覆盖（`SuperTaskSpec.modelId`）。 */
  taskModelId?: string | null;
  /** 超流体链路独立模型 `iflow.superAgentModel`。 */
  superModelId?: string | null;
  /**
   * 目标 Profile 自带的模型名（一般是解析出的端点的 modelName）。
   *
   * `null` = **明确没有**这个候选（模型链直接落到主 store 的 currentModelId）；
   * `undefined` = 没给（由 {@link resolveSuperApiSpec} 按端点补齐）。
   */
  profileModelName?: string | null;
  /** 主会话当前模型（store 的 `currentModelId`）。 */
  mainModelId?: string | null;
  /**
   * live `/models` 查询得到的模型 id 列表。
   *
   * - `null` / `undefined`：**查询失败** —— 不构成下架证据，照常推送；
   * - `[]`：**空列表** —— 同样不构成下架证据（端点挂了 ≠ 模型没了）；
   * - 非空列表：只有「列表里确实没有目标模型」才**能证明下架**。
   *
   * 列表里的空白 id 会被剔除；剔除后为空视同「空列表」（不构成下架证据）。
   */
  liveModelIds?: readonly string[] | null;
}

/** 模型解析结果。 */
export interface SuperModelResolution {
  /** 最终要推送的模型 id；null = 没有可推送的模型（调用方据此不发 `set_model`）。 */
  modelId: string | null;
  /** 命中了链上的哪一级；null = 链上一个候选都没有。 */
  source: SuperModelSource | null;
  /** true = 因模型下架而**显式降级**（降级一定带原因，不静默换模型）。 */
  degraded: boolean;
  /** 降级原因（`degraded` 为 true 时必有）。 */
  reason?: string;
  /** 被判定为已下架的模型 id（仅 `degraded` 时有值）。 */
  delistedModelId?: string;
}

/**
 * 按优先级链解析超流体子会话该用的模型，并做 live 下架判定。
 *
 * 关键纪律（AGENTS.md 陷阱 #25）：**空的 / 失败的 live 查询不构成下架证据**。
 * 只有「live 列表非空且确实不含目标模型」才降级，且降级是显式的（带原因），
 * 绝不静默换一个模型。
 */
export function resolveSuperModel(input: SuperModelInput): SuperModelResolution {
  // 链上的候选（顺序即优先级）。
  const candidates: Array<{ source: SuperModelSource; id: string }> = [];
  const add = (source: SuperModelSource, raw: string | null | undefined): void => {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) return;
    candidates.push({ source, id });
  };
  add("task-model", input.taskModelId);
  add("super-model", input.superModelId);
  add("profile-model", input.profileModelName);
  add("main-model", input.mainModelId);

  const desired = candidates[0];
  // 链上一个候选都没有 → 不编造模型（返回 null，由调用方不推 set_model）。
  if (!desired) return { modelId: null, source: null, degraded: false };

  const live = normalizeLiveModelIds(input.liveModelIds);
  // 空列表 / 查询失败 / 只含空白项 —— **不构成下架证据**，照常推送目标模型。
  if (live.length === 0) {
    return { modelId: desired.id, source: desired.source, degraded: false };
  }
  if (live.includes(desired.id)) {
    return { modelId: desired.id, source: desired.source, degraded: false };
  }
  // 走到这里 = **能证明下架**：live 列表非空，且确实不含目标模型。
  // 先在链上更低的候选里找一个仍在 live 列表里的。
  for (const candidate of candidates.slice(1)) {
    if (!live.includes(candidate.id)) continue;
    return {
      modelId: candidate.id,
      source: candidate.source,
      degraded: true,
      delistedModelId: desired.id,
      reason: `模型 ${desired.id} 已不在当前可用列表中，已回退为 ${candidate.id}`,
    };
  }
  // 链上候选都不在 live 列表里 → 用 live 列表首个模型兜底（同主会话兜底口径）。
  const head = live[0];
  if (head === undefined) {
    // 理论上不可达（上面已判过 length === 0），但数组索引必须显式兜住。
    return { modelId: desired.id, source: desired.source, degraded: false };
  }
  return {
    modelId: head,
    source: "live-fallback",
    degraded: true,
    delistedModelId: desired.id,
    reason: `模型 ${desired.id} 已不在当前可用列表中，已回退为 ${head}`,
  };
}

/** 一个子会话最终该用的 API 配置（端点 + 凭据 + 模型）。 */
export interface SuperApiSpec {
  /** 解析出的端点与凭据；null = 没有可用凭据（不推 `authenticate`）。 */
  endpoint: SuperEndpoint | null;
  /** 解析出的模型（`modelId` 为 null = 无可推送模型，不发 `set_model`）。 */
  model: SuperModelResolution;
}

/** {@link resolveSuperApiSpec} 的入参 = 端点链 + 模型链的入参合并。 */
export interface SuperApiSpecInput extends SuperEndpointInput, SuperModelInput {}

/**
 * 一次性解析出「这个子会话该用的端点 + 模型」。
 *
 * 与 {@link resolveSuperEndpoint} / {@link resolveSuperModel} 的唯一差别：
 * **没显式给** `profileModelName` 时，自动取**解析出的端点**自带的模型名 ——
 * 两条链就是这样咬合的（端点来自某 Profile，模型默认就跟着那个 Profile 走）。
 *
 * `profileModelName: null` 与「没给」是**两件事**，别混：
 *  - **没给（`undefined`）或给了空串** → 用端点自带的 modelName 补模型链
 *    （§3.2 第 3 级，空串按「没给」处理，不当成退出）。
 *  - **显式给 `null`** → **不要** Profile 自带的模型名，模型链直接落到第 4 级
 *    （主 store 的 `currentModelId`）。
 *
 * 为什么需要这个「退出口」：今天子会话的模型取自主会话 store 的
 * `currentModelId`（`deps.currentModel()`），而 §3.2 第 3 级取的是**主链路
 * Profile 的默认 `modelName`**。用户在主会话里换过模型之后，两者不再相等 ——
 * 若不显式传 `null`，超流体在**完全未配置**的情况下也会静默把模型换回 Profile
 * 的默认值，直接违反方案文档 §4.1「老用户零配置零行为变化」。
 */
export function resolveSuperApiSpec(input: SuperApiSpecInput): SuperApiSpec {
  const endpoint = resolveSuperEndpoint(input);
  // 「显式 null」= 明确不要 Profile 自带的模型名（模型链落到主 store 的
  // currentModelId）；「没给 / 空串」= 用端点自带的 modelName 补模型链（默认）。
  const profileModelName =
    input.profileModelName === null
      ? null
      : (normalizeModelName(input.profileModelName) ?? endpoint?.modelName ?? null);
  const model = resolveSuperModel({
    taskModelId: input.taskModelId,
    superModelId: input.superModelId,
    profileModelName,
    mainModelId: input.mainModelId,
    liveModelIds: input.liveModelIds,
  });
  return { endpoint, model };
}
