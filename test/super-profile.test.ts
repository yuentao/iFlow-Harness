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

  it("4. 主链路指针缺失时回退内核 currentApiProfile", () => {
    const endpoint = resolveSuperEndpoint(endpointInput({ kernelProfileName: "kernel" }));
    expect(endpoint?.source).toBe("kernel-profile");
    expect(endpoint?.profileName).toBe("kernel");
    expect(endpoint?.baseUrl).toBe("https://kernel.example/v1");
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

  it("live 列表含目标模型 → 不降级", () => {
    const model = resolveSuperModel(
      modelInput({ taskModelId: "m-task", liveModelIds: ["m-other", "m-task"] }),
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

describe("纯逻辑层纪律", () => {
  it("本模块不写任何设置 —— 源码里不出现跨窗口全局指针 iflow.active-profile", () => {
    const source = readFileSync(
      new URL("../shared/super-profile.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("iflow.active-profile");
    expect(source).not.toContain("ACTIVE_PROFILE_KEY");
  });

  it("本模块零 VSCode 依赖 —— 源码里不 import vscode", () => {
    const source = readFileSync(
      new URL("../shared/super-profile.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']vscode["']/);
    expect(source).not.toMatch(/require\(\s*["']vscode["']\s*\)/);
  });
});
