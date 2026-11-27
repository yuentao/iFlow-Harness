import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveSuperApiSpec,
  resolveSuperEndpoint,
  resolveSuperModel,
  type SuperApiProfile,
  type SuperEndpointInput,
  type SuperModelInput,
} from "../shared/super-profile.js";
import {
  fromPersistedSuperSession,
  toPersistedSuperSession,
  type PersistedSuperSession,
  type SuperSessionUi,
} from "../shared/super-agent.js";

/**
 * 具名 Profile 库（宿主把 SecretStorage `iflow.profiles` 与内核 `apiProfiles`
 * 合并后的形状）。四个 Profile 各带不同 baseUrl / apiKey / modelName，用来
 * 断言「命中的是哪一级指针」。
 */
const profiles: Record<string, SuperApiProfile> = {
  task: { baseUrl: "https://task.example/v1", apiKey: "key-task", modelName: "task-profile-model" },
  super: {
    baseUrl: "https://super.example/v1",
    apiKey: "key-super",
    modelName: "super-profile-model",
  },
  main: { baseUrl: "https://main.example/v1", apiKey: "key-main", modelName: "main-profile-model" },
  kernel: {
    baseUrl: "https://kernel.example/v1",
    apiKey: "key-kernel",
    modelName: "kernel-profile-model",
  },
  broken: { baseUrl: "", apiKey: "key-broken", modelName: null },
  "no-key": { baseUrl: "https://nokey.example/v1", apiKey: "", modelName: null },
};

/** 活动凭据（`iflow.openai-compatible`）：链上一个具名 Profile 都没有时的兜底。 */
const activeCredentials: SuperApiProfile = {
  baseUrl: "https://active.example/v1",
  apiKey: "key-active",
  modelName: "active-credentials-model",
};

function endpointInput(overrides: Partial<SuperEndpointInput> = {}): SuperEndpointInput {
  return { profiles, activeCredentials, ...overrides };
}

function modelInput(overrides: Partial<SuperModelInput> = {}): SuperModelInput {
  return { ...overrides };
}

describe("resolveSuperEndpoint —— 端点优先级链", () => {
  it("1. 任务级 profileId 优先于超流体链路指针", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ taskProfileId: "task", superProfileName: "super" }),
    );
    expect(endpoint).not.toBeNull();
    expect(endpoint?.source).toBe("task-profile");
    expect(endpoint?.profileName).toBe("task");
    expect(endpoint?.baseUrl).toBe("https://task.example/v1");
    expect(endpoint?.apiKey).toBe("key-task");
    expect(endpoint?.modelName).toBe("task-profile-model");
  });

  it("2. 超流体链路指针优先于主链路活动 Profile", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ superProfileName: "super", mainProfileName: "main" }),
    );
    expect(endpoint?.source).toBe("super-profile");
    expect(endpoint?.profileName).toBe("super");
    expect(endpoint?.baseUrl).toBe("https://super.example/v1");
  });

  it("3. 主链路活动 Profile 优先于内核 currentApiProfile", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ mainProfileName: "main", kernelProfileName: "kernel" }),
    );
    expect(endpoint?.source).toBe("main-profile");
    expect(endpoint?.profileName).toBe("main");
    expect(endpoint?.baseUrl).toBe("https://main.example/v1");
  });

  it("4. 主链路指针与活动凭据都缺失时回退内核 currentApiProfile（最后一档）", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ kernelProfileName: "kernel", activeCredentials: null }),
    );
    expect(endpoint?.source).toBe("kernel-profile");
    expect(endpoint?.profileName).toBe("kernel");
    expect(endpoint?.baseUrl).toBe("https://kernel.example/v1");
  });

  it("4b. 活动凭据先于内核 currentApiProfile 命中（与子会话握手路径一致）", () => {
    // 今天子会话的凭据链是 resolveWorkspaceHandshakeCreds() ?? loadCredentials()；
    // 内核 currentApiProfile 只在两者都没有时兜底，不能抢在活动凭据之前。
    const both = resolveSuperEndpoint(endpointInput({ kernelProfileName: "kernel" }));
    expect(both?.source).toBe("active-credentials");
    expect(both?.apiKey).toBe("key-active");

    const noActive = resolveSuperEndpoint(
      endpointInput({ kernelProfileName: "kernel", activeCredentials: null }),
    );
    expect(noActive?.source).toBe("kernel-profile");
  });

  it("4c. 主链路活动 Profile 优先于活动凭据（③先于④）", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ mainProfileName: "main", kernelProfileName: "kernel" }),
    );
    expect(endpoint?.source).toBe("main-profile");
    expect(endpoint?.apiKey).toBe("key-main");
  });

  it("5. 指针指向不存在的 Profile 时继续往下回退", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ taskProfileId: "missing", superProfileName: "super" }),
    );
    expect(endpoint?.source).toBe("super-profile");
    expect(endpoint?.profileName).toBe("super");
  });

  it("6. Profile 缺少 baseUrl / apiKey 时不算可用，继续回退", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ taskProfileId: "broken", superProfileName: "super" }),
    );
    expect(endpoint?.source).toBe("super-profile");
    expect(endpoint?.profileName).toBe("super");
  });

  it("6b. Profile 缺 apiKey（不是缺 baseUrl）时同样不算可用，继续回退", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ taskProfileId: "no-key", superProfileName: "super" }),
    );
    expect(endpoint?.source).toBe("super-profile");
    expect(endpoint?.profileName).toBe("super");
  });

  it("6c. baseUrl / apiKey / modelName 前后空白会被 trim", () => {
    const endpoint = resolveSuperEndpoint({
      profiles: {
        padded: {
          baseUrl: "  https://padded.example/v1  ",
          apiKey: "  key-padded  ",
          modelName: "  m-padded  ",
        },
      },
      taskProfileId: "padded",
      activeCredentials: null,
    });
    expect(endpoint?.baseUrl).toBe("https://padded.example/v1");
    expect(endpoint?.apiKey).toBe("key-padded");
    expect(endpoint?.modelName).toBe("m-padded");
  });

  it("6d. Profile 的 modelName 畸形（非字符串）时归一为 null，不抛错", () => {
    // 宿主的 Profile 库可能来自未经字段过滤的原始 JSON（readActiveEndpoint
    // 就不过滤），一个非字符串的 modelName 不该把「解析配置」变成一次崩溃。
    const malformed = {
      baseUrl: "https://bad.example/v1",
      apiKey: "key-bad",
      modelName: 123,
    } as unknown as SuperApiProfile;
    const endpoint = resolveSuperEndpoint({
      profiles: { bad: malformed },
      taskProfileId: "bad",
      activeCredentials: null,
    });
    expect(endpoint).not.toBeNull();
    expect(endpoint?.baseUrl).toBe("https://bad.example/v1");
    expect(endpoint?.modelName).toBeNull();
  });

  it("7. 所有具名 Profile 都不可用时回退活动凭据（未配置即跟随主会话）", () => {
    const endpoint = resolveSuperEndpoint(endpointInput());
    expect(endpoint?.source).toBe("active-credentials");
    expect(endpoint?.profileName).toBeNull();
    expect(endpoint?.baseUrl).toBe("https://active.example/v1");
    expect(endpoint?.apiKey).toBe("key-active");
    expect(endpoint?.modelName).toBe("active-credentials-model");
  });

  it("8. 什么都没配置时返回 null（宿主据此不推 authenticate）", () => {
    const endpoint = resolveSuperEndpoint({ profiles: {}, activeCredentials: null });
    expect(endpoint).toBeNull();
  });

  it("8b. 活动凭据不完整（缺 baseUrl 或 apiKey）时同样返回 null", () => {
    expect(resolveSuperEndpoint({ profiles: {}, activeCredentials: null })).toBeNull();
    expect(
      resolveSuperEndpoint({
        profiles: {},
        activeCredentials: { baseUrl: "", apiKey: "k", modelName: null },
      }),
    ).toBeNull();
    expect(
      resolveSuperEndpoint({
        profiles: {},
        activeCredentials: { baseUrl: "https://x.example/v1", apiKey: "", modelName: null },
      }),
    ).toBeNull();
  });

  it("9. 空白指针名按未配置处理", () => {
    const endpoint = resolveSuperEndpoint(
      endpointInput({ taskProfileId: "   ", superProfileName: "", mainProfileName: "\t" }),
    );
    expect(endpoint?.source).toBe("active-credentials");
  });
});

describe("resolveSuperModel —— 模型优先级链", () => {
  it("1. 任务级 modelId 优先于一切", () => {
    const model = resolveSuperModel(
      modelInput({
        taskModelId: "m-task",
        superModelId: "m-super",
        profileModelName: "p-model",
        mainModelId: "m-main",
      }),
    );
    expect(model.modelId).toBe("m-task");
    expect(model.source).toBe("task-model");
    expect(model.degraded).toBe(false);
  });

  it("2. 超流体链路模型优先于 Profile 自带模型名", () => {
    const model = resolveSuperModel(
      modelInput({ superModelId: "m-super", profileModelName: "p-model", mainModelId: "m-main" }),
    );
    expect(model.modelId).toBe("m-super");
    expect(model.source).toBe("super-model");
  });

  it("3. Profile 自带模型名优先于主会话当前模型", () => {
    const model = resolveSuperModel(
      modelInput({ profileModelName: "p-model", mainModelId: "m-main" }),
    );
    expect(model.modelId).toBe("p-model");
    expect(model.source).toBe("profile-model");
  });

  it("4. 前面都没有时回退主会话当前模型（未配置即跟随主会话）", () => {
    const model = resolveSuperModel(modelInput({ mainModelId: "m-main" }));
    expect(model.modelId).toBe("m-main");
    expect(model.source).toBe("main-model");
  });

  it("5. 链上一个候选都没有时返回 null，不编造模型", () => {
    const model = resolveSuperModel(modelInput());
    expect(model.modelId).toBeNull();
    expect(model.source).toBeNull();
    expect(model.degraded).toBe(false);
  });

  it("5b. profileModelName 显式给 null = 没有这个候选（落到主会话当前模型）", () => {
    const model = resolveSuperModel(modelInput({ profileModelName: null, mainModelId: "m-main" }));
    expect(model.modelId).toBe("m-main");
    expect(model.source).toBe("main-model");
  });

  it("6. 空白模型 id 按未配置处理", () => {
    const model = resolveSuperModel(modelInput({ taskModelId: "   ", mainModelId: "m-main" }));
    expect(model.modelId).toBe("m-main");
    expect(model.source).toBe("main-model");
  });
});

describe("resolveSuperModel —— live 下架判定（防误伤）", () => {
  it("空的 live 模型列表不构成下架证据，照常使用目标模型", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: [] }),
    );
    expect(model.modelId).toBe("m-task");
    expect(model.source).toBe("task-model");
    expect(model.degraded).toBe(false);
    expect(model.reason).toBeUndefined();
    expect(model.delistedModelId).toBeUndefined();
  });

  it("live 查询失败（null / undefined）不构成下架证据，照常使用目标模型", () => {
    const failed = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: null }),
    );
    expect(failed.modelId).toBe("m-task");
    expect(failed.degraded).toBe(false);

    const missing = resolveSuperModel(modelInput({ taskModelId: "m-task" }));
    expect(missing.modelId).toBe("m-task");
    expect(missing.degraded).toBe(false);
  });

  it("live 列表里只有空白项时同样不构成下架证据（与空列表同义）", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: ["", "   "] }),
    );
    expect(model.modelId).toBe("m-task");
    expect(model.source).toBe("task-model");
    expect(model.degraded).toBe(false);
    expect(model.reason).toBeUndefined();
  });

  it("live 列表含目标模型 → 不降级", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: ["m-other", "m-task"] }),
    );
    expect(model.modelId).toBe("m-task");
    expect(model.degraded).toBe(false);
  });

  it("live 列表里的 id 带空白时按 trim 后的 id 命中（不误判成下架）", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: [" m-task "] }),
    );
    expect(model.modelId).toBe("m-task");
    expect(model.degraded).toBe(false);
  });

  it("能证明下架时降级到链上仍在 live 列表里的候选", () => {
    const model = resolveSuperModel(
      modelInput({
        taskModelId: "m-gone",
        superModelId: "m-super",
        profileModelName: "p-model",
        mainModelId: "m-main",
        liveModelIds: ["m-super", "m-main"],
      }),
    );
    expect(model.modelId).toBe("m-super");
    expect(model.source).toBe("super-model");
    expect(model.degraded).toBe(true);
    expect(model.delistedModelId).toBe("m-gone");
    expect(model.reason).toContain("m-gone");
    expect(model.reason).toContain("m-super");
  });

  it("下架后回退到链上更低的 profile-model 候选（不止 super-model 一档）", () => {
    const model = resolveSuperModel(
      modelInput({
        taskModelId: "m-gone",
        profileModelName: "p-alive",
        mainModelId: "m-main",
        liveModelIds: ["p-alive", "m-main"],
      }),
    );
    expect(model.modelId).toBe("p-alive");
    expect(model.source).toBe("profile-model");
    expect(model.degraded).toBe(true);
    expect(model.delistedModelId).toBe("m-gone");
  });

  it("链上候选都不在 live 列表时兜底到 live 列表首个模型", () => {
    const model = resolveSuperModel(
      modelInput({
        taskModelId: "m-gone",
        superModelId: "m-also-gone",
        mainModelId: "m-still-gone",
        liveModelIds: ["live-first", "live-second"],
      }),
    );
    expect(model.modelId).toBe("live-first");
    expect(model.source).toBe("live-fallback");
    expect(model.degraded).toBe(true);
    expect(model.delistedModelId).toBe("m-gone");
  });

  it("live 列表混着空串时，兜底不会推一个空模型 id", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-gone", liveModelIds: ["", "live-first"] }),
    );
    expect(model.modelId).toBe("live-first");
    expect(model.source).toBe("live-fallback");
    expect(model.degraded).toBe(true);
  });

  it("下架降级一定带原因，不静默换模型", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-gone", liveModelIds: ["live-first"] }),
    );
    expect(model.degraded).toBe(true);
    expect(typeof model.reason).toBe("string");
    expect(model.reason?.length).toBeGreaterThan(0);
  });
});

describe("resolveSuperApiSpec —— 端点与模型的最终组合", () => {
  it("端点与模型可以分别来自不同来源", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      taskProfileId: "task",
      superModelId: "m-super",
      mainModelId: "m-main",
    });
    expect(spec.endpoint?.source).toBe("task-profile");
    expect(spec.endpoint?.baseUrl).toBe("https://task.example/v1");
    expect(spec.model.source).toBe("super-model");
    expect(spec.model.modelId).toBe("m-super");
    expect(spec.model.degraded).toBe(false);
  });

  it("没显式给模型时用端点自带的模型名补上模型链", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      superProfileName: "super",
    });
    expect(spec.endpoint?.source).toBe("super-profile");
    expect(spec.model.source).toBe("profile-model");
    expect(spec.model.modelId).toBe("super-profile-model");
  });

  it("显式 profileModelName 优先于端点自带的模型名", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      superProfileName: "super",
      profileModelName: "explicit-model",
    });
    expect(spec.model.modelId).toBe("explicit-model");
    expect(spec.model.source).toBe("profile-model");
  });

  it("显式 profileModelName: null → 不用端点自带模型名，落到主会话当前模型", () => {
    // 这是「未配置超流体时行为与今天一致」的退出口：今天的子会话模型取自主
    // 会话 store 的 currentModelId，而不是主链路 Profile 的默认 modelName。
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      superProfileName: "super",
      profileModelName: null,
      mainModelId: "m-main",
    });
    expect(spec.endpoint?.source).toBe("super-profile");
    expect(spec.model.source).toBe("main-model");
    expect(spec.model.modelId).toBe("m-main");
  });

  it("profileModelName 传空串 = 按没给处理（仍用端点自带模型名）", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      superProfileName: "super",
      profileModelName: "",
    });
    expect(spec.model.source).toBe("profile-model");
    expect(spec.model.modelId).toBe("super-profile-model");
  });

  it("端点落到活动凭据时，模型仍可独立来自任务级覆盖", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      taskModelId: "m-task",
    });
    expect(spec.endpoint?.source).toBe("active-credentials");
    expect(spec.model.source).toBe("task-model");
    expect(spec.model.modelId).toBe("m-task");
  });

  it("没有任何端点时仍能解析出模型（两者相互独立）", () => {
    const spec = resolveSuperApiSpec({ profiles: {}, activeCredentials: null, mainModelId: "m-main" });
    expect(spec.endpoint).toBeNull();
    expect(spec.model.modelId).toBe("m-main");
  });

  it("端点为 null 且 live 列表非空不含目标模型时，降级显式带原因", () => {
    const spec = resolveSuperApiSpec({
      profiles: {},
      activeCredentials: null,
      mainModelId: "m-gone",
      liveModelIds: ["live-first"],
    });
    expect(spec.endpoint).toBeNull();
    expect(spec.model.degraded).toBe(true);
    expect(spec.model.source).toBe("live-fallback");
    expect(spec.model.modelId).toBe("live-first");
    expect(spec.model.delistedModelId).toBe("m-gone");
    expect(typeof spec.model.reason).toBe("string");
  });

  it("组合结果同样遵守「空 live 列表不算下架」", () => {
    const spec = resolveSuperApiSpec({
      profiles,
      activeCredentials,
      taskProfileId: "task",
      taskModelId: "m-task",
      liveModelIds: [],
    });
    expect(spec.model.modelId).toBe("m-task");
    expect(spec.model.degraded).toBe(false);
  });
});

describe("持久化往返 —— profileId 不丢字段", () => {
  function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
    return {
      id: "super-1",
      title: "修复登录跳转",
      task: "修好它",
      status: "completed",
      isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
      model: "m-task",
      profileId: "super-gw",
      createdAt: 1000,
      updatedAt: 2000,
      reports: [],
      ...overrides,
    };
  }

  it("profileId 在 toPersistedSuperSession / fromPersistedSuperSession 双向透传", () => {
    const persisted = toPersistedSuperSession(session());
    expect(persisted.profileId).toBe("super-gw");
    const restored = fromPersistedSuperSession(persisted);
    expect(restored.profileId).toBe("super-gw");
  });

  it("model 与 profileId 成对透传（网关 + 模型一起说明这次子会话跑在哪）", () => {
    const persisted = toPersistedSuperSession(
      session({ model: "deepseek-chat", profileId: "super-gw" }),
    );
    const restored = fromPersistedSuperSession(persisted);
    expect(restored.model).toBe("deepseek-chat");
    expect(restored.profileId).toBe("super-gw");
  });

  it("老归档文件（根本没有 profileId 这个键）读取时不崩，字段为 undefined", () => {
    const persisted = toPersistedSuperSession(session());
    const legacy = JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
    delete legacy["profileId"];
    const restored = fromPersistedSuperSession(legacy as unknown as PersistedSuperSession);
    expect(restored.profileId).toBeUndefined();
    expect(restored.model).toBe("m-task");
    expect(restored.status).toBe("completed");
  });

  it("没有 profileId 的会话落盘后字段仍是 undefined（不凭空造一个）", () => {
    const persisted = toPersistedSuperSession(session({ profileId: undefined }));
    expect(persisted.profileId).toBeUndefined();
    const restored = fromPersistedSuperSession(persisted);
    expect(restored.profileId).toBeUndefined();
  });
});

describe("纯逻辑层纪律", () => {
  const source = readFileSync(new URL("../shared/super-profile.ts", import.meta.url), "utf8");

  it("本模块不写任何设置 —— 源码里不出现跨窗口全局指针 iflow.active-profile", () => {
    expect(source).not.toContain("iflow.active-profile");
    expect(source).not.toContain("ACTIVE_PROFILE_KEY");
  });

  it("本模块零 VSCode 依赖 —— 源码里不 import vscode", () => {
    expect(source).not.toMatch(/from\s+["']vscode["']/);
    expect(source).not.toMatch(/require\(\s*["']vscode["']\s*\)/);
  });

  it("本模块零 import —— 纯函数不依赖任何模块（含 node 内置模块）", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/from\s+["']node:/);
  });

  it("本模块无副作用 —— 没有时钟 / 随机数 / 环境变量 / 进程状态", () => {
    expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random/);
    expect(source).not.toMatch(/process\.(env|cwd|hrtime|argv)/);
  });

  it("本模块不写盘、不写设置、不写密钥", () => {
    expect(source).not.toMatch(/\b(writeFile|writeFileSync|appendFile|renameSync|unlinkSync)\b/);
    expect(source).not.toMatch(/secrets\.(store|delete|get)\b/);
    expect(
      source,
    ).not.toMatch(/\b(updateCliSettings|setKernelActiveProfile|saveProfiles|saveCredentials|clearCredentials)\b/);
  });
});
