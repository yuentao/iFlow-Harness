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
 *     4. 内核 `currentApiProfile`       —— workspaceState 缺失时再回退
 *     5. 活动凭据 / 内核默认            —— 以上 Profile 都不可用时
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
  /** 内核 `currentApiProfile`。 */
  | "kernel-profile"
  /** 活动凭据（`iflow.openai-compatible`）/ 内核顶层默认。 */
  | "active-credentials";

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
  /** 内核 `currentApiProfile`（workspaceState 缺失时再回退）。 */
  kernelProfileName?: string | null;
  /** 具名 Profile 库（宿主把 SecretStorage 与内核 `apiProfiles` 合并后的结果）。 */
  profiles?: Readonly<Record<string, SuperApiProfile>> | null;
  /** 活动凭据（`iflow.openai-compatible`）；内核顶层设置也由宿主归入此处。 */
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
  /** 命中的具名 Profile 名（来自活动凭据时为 null）。 */
  profileName: string | null;
}

/**
 * 按优先级链解析超流体子会话该用的端点 / 凭据来源。
 *
 * 返回 null = 一份可用凭据都没有（宿主据此不推 `authenticate`，沿用 CLI 自身
 * 的启动配置）。**未配置超流体链路时必然落回主链路**（第 3 / 4 级），因此老
 * 用户零配置零行为变化。
 */
export function resolveSuperEndpoint(input: SuperEndpointInput): SuperEndpoint | null {
  const profiles = input.profiles ?? {};
  // 链上的具名 Profile 指针（顺序即优先级）。
  const named: Array<{ name: string | null | undefined; source: SuperEndpointSource }> = [
    { name: input.taskProfileId, source: "task-profile" },
    { name: input.superProfileName, source: "super-profile" },
    { name: input.mainProfileName, source: "main-profile" },
    { name: input.kernelProfileName, source: "kernel-profile" },
  ];
  for (const candidate of named) {
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    const profile = profiles[name];
    // 指针指向的 Profile 不存在 / 不完整 → 继续往下回退（见文件头取舍说明）。
    if (!profile) continue;
    const baseUrl = typeof profile.baseUrl === "string" ? profile.baseUrl.trim() : "";
    const apiKey = typeof profile.apiKey === "string" ? profile.apiKey.trim() : "";
    if (!baseUrl || !apiKey) continue;
    return {
      baseUrl,
      apiKey,
      modelName: profile.modelName?.trim() || null,
      source: candidate.source,
      profileName: name,
    };
  }
  // 链上没有一个可用的具名 Profile → 落回活动凭据 / 内核默认。
  const active = input.activeCredentials;
  if (active) {
    const baseUrl = typeof active.baseUrl === "string" ? active.baseUrl.trim() : "";
    const apiKey = typeof active.apiKey === "string" ? active.apiKey.trim() : "";
    if (baseUrl && apiKey) {
      return {
        baseUrl,
        apiKey,
        modelName: active.modelName?.trim() || null,
        source: "active-credentials",
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
  /** 目标 Profile 自带的模型名（一般是解析出的端点的 modelName）。 */
  profileModelName?: string | null;
  /** 主会话当前模型（store 的 `currentModelId`）。 */
  mainModelId?: string | null;
  /**
   * live `/models` 查询得到的模型 id 列表。
   *
   * - `null` / `undefined`：**查询失败** —— 不构成下架证据，照常推送；
   * - `[]`：**空列表** —— 同样不构成下架证据（端点挂了 ≠ 模型没了）；
   * - 非空列表：只有「列表里确实没有目标模型」才**能证明下架**。
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

  const live = input.liveModelIds;
  // 空列表 / 查询失败 —— **不构成下架证据**，照常推送目标模型。
  if (!live || live.length === 0) {
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
 * 没显式给 `profileModelName` 时，自动取**解析出的端点**自带的模型名 —— 两条
 * 链就是这样咬合的（端点来自某 Profile，模型默认就跟着那个 Profile 走）。
 */
export function resolveSuperApiSpec(input: SuperApiSpecInput): SuperApiSpec {
  const endpoint = resolveSuperEndpoint(input);
  const profileModelName = input.profileModelName?.trim() || endpoint?.modelName || null;
  const model = resolveSuperModel({
    taskModelId: input.taskModelId,
    superModelId: input.superModelId,
    profileModelName,
    mainModelId: input.mainModelId,
    liveModelIds: input.liveModelIds,
  });
  return { endpoint, model };
}
