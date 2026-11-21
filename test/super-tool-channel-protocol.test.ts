import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { HostToWebview, SuperResidueBranchUi, WebviewToHost } from "../shared/messages.js";

/**
 * 批次1B 工具通道协议：super-agent-loader 的依赖字段 schema + 消息协议声明的契约测试。
 *
 * loader 是随内置 CLI 发布的 CJS 模块，用与 api-config-isolation-loader.test.ts 相同的
 * createRequire 方式直接 require，不改 vendor bundle 的其它部分。
 */
interface LoaderTool {
  schema: {
    name: string;
    description: string;
    parameters: {
      properties: {
        tasks: {
          items: {
            properties: Record<string, { type: string; description?: string }>;
            required?: string[];
          };
        };
      };
    };
  };
  validateToolParams(params: unknown): string | null;
  execute(params: unknown): Promise<{ llmContent: string; returnDisplay: string }>;
}

interface LoaderModule {
  create(bag: {
    base: new (...args: unknown[]) => object;
    types?: Record<string, string>;
  }): (new (config: unknown) => LoaderTool) | null;
  TOOL_NAME: string;
}

// 复刻 CLI 0.5.19 工具基类 Li 的构造签名与 schema getter（loader 只依赖这两个面）。
class StubBase {
  name: string;
  displayName: string;
  description: string;
  parameterSchema: unknown;
  constructor(name: string, displayName: string, description: string, _icon: string, _kind: string, parameterSchema: unknown) {
    this.name = name;
    this.displayName = displayName;
    this.description = description;
    this.parameterSchema = parameterSchema;
  }
  get schema(): LoaderTool["schema"] {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameterSchema as LoaderTool["schema"]["parameters"],
    };
  }
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/super-agent-loader.cjs") as LoaderModule;

const TYPES = {
  OBJECT: "OBJECT",
  STRING: "STRING",
  ARRAY: "ARRAY",
  BOOLEAN: "BOOLEAN",
  NUMBER: "NUMBER",
};

function makeTool(): LoaderTool {
  const Tool = loader.create({ base: StubBase, types: TYPES });
  if (!Tool) throw new Error("loader.create() returned null");
  return new Tool({});
}

describe("super-agent-loader · 依赖字段透传", () => {
  it("create() 产出的工具 schema 声明 id/dependsOn/batch/maxAttempts", () => {
    const props = makeTool().schema.parameters.properties.tasks.items.properties;
    expect(Object.keys(props)).toEqual([
      "title",
      "task",
      "attachments",
      "id",
      "dependsOn",
      "batch",
      "maxAttempts",
    ]);
    expect(props.id?.type).toBe("STRING");
    expect(props.dependsOn?.type).toBe("ARRAY");
    expect(props.batch?.type).toBe("NUMBER");
    expect(props.maxAttempts?.type).toBe("NUMBER");
  });

  it("description 告诉模型这些字段可由工具通道携带", () => {
    const description = makeTool().schema.description;
    for (const field of ["dependsOn", "batch", "maxAttempts", "id"]) {
      expect(description).toContain(field);
    }
  });

  it("四个字段全部给出合法值时校验通过（原样交给宿主）", () => {
    const params = {
      tasks: [
        {
          title: "数据层",
          task: "实现数据层",
          id: "data",
          dependsOn: ["bootstrap"],
          batch: 2,
          maxAttempts: 3,
        },
      ],
    };
    expect(makeTool().validateToolParams(params)).toBeNull();
  });

  it.each([
    ["id", { task: "x", id: 7 }, "id must be a string"],
    ["dependsOn 非数组", { task: "x", dependsOn: 42 }, "dependsOn must be an array"],
    ["dependsOn 元素非字符串", { task: "x", dependsOn: [1] }, "dependsOn[0] must be a string"],
    ["batch 字符串", { task: "x", batch: "2" }, "batch must be a positive integer"],
    ["batch 零", { task: "x", batch: 0 }, "batch must be a positive integer"],
    ["maxAttempts 字符串", { task: "x", maxAttempts: "3" }, "maxAttempts must be a positive integer"],
    ["maxAttempts 零", { task: "x", maxAttempts: 0 }, "maxAttempts must be a positive integer"],
  ] as const)("类型写坏时当场报错：%s", (_name, task, expected) => {
    const message = makeTool().validateToolParams({ tasks: [task] });
    expect(message).not.toBeNull();
    expect(message).toContain(expected);
  });

  it("execute() 只回 ack，不改写调用方载荷（字段原样透传给宿主）", async () => {
    const params = {
      tasks: [
        { title: "A", task: "任务 A", dependsOn: ["B"], batch: 1, maxAttempts: 2 },
        { title: "B", task: "任务 B" },
      ],
    };
    const snapshot = JSON.stringify(params);
    const result = await makeTool().execute(params);
    expect(result).toEqual({ llmContent: "Delegation request accepted.", returnDisplay: "Delegation request accepted." });
    expect(JSON.stringify(params)).toBe(snapshot);
  });

  it("loader 不重复实现跨任务语义校验（dependsOn+batch 可到共享层出 issue）", () => {
    // 共享层 planSuperWaves 才会把混用判成 issue；loader 只管逐字段类型。
    expect(
      makeTool().validateToolParams({ tasks: [{ task: "x", dependsOn: ["B"], batch: 1 }] }),
    ).toBeNull();
  });
});

describe("批次1B · 消息协议声明", () => {
  it("superRetryWave / superRetryFailed 在 WebviewToHost 联合里可赋值", () => {
    const wave: WebviewToHost = { type: "superRetryWave", runId: "run-1", wave: 2 };
    const failed: WebviewToHost = { type: "superRetryFailed" };
    const failedWithRun: WebviewToHost = { type: "superRetryFailed", runId: "run-1" };
    expect(wave.type).toBe("superRetryWave");
    expect(failed.type).toBe("superRetryFailed");
    expect(failedWithRun.runId).toBe("run-1");
  });

  it("残留分支清单请求 / 一键处理在 WebviewToHost 里结构齐全", () => {
    const list: WebviewToHost = { type: "requestSuperResidueList", requestId: "req-1" };
    const handle: WebviewToHost = {
      type: "superResidueHandle",
      action: "merge",
      sessionIds: ["child-1", "child-2"],
      confirmToken: "tok-xyz",
    };
    const discard: WebviewToHost = {
      type: "superResidueHandle",
      action: "discard",
      sessionIds: ["child-3"],
      confirmToken: "tok-xyz",
    };
    expect(list.type).toBe("requestSuperResidueList");
    expect(handle.action).toBe("merge");
    expect(handle.sessionIds).toHaveLength(2);
    expect(discard.action).toBe("discard");
    expect(discard.confirmToken).toBe("tok-xyz");
  });

  it("superResidueList 回包在 HostToWebview 里携带清单与一次性令牌", () => {
    const branch: SuperResidueBranchUi = {
      sessionId: "child-1",
      branch: "iflow/super/demo-ab12",
      worktree: "J:\\repo-super-worktrees\\demo-ab12",
      title: "demo",
      mainSessionId: "main-1",
      unmerged: true,
      worktreeExists: true,
    };
    const msg: HostToWebview = {
      type: "superResidueList",
      requestId: "req-1",
      branches: [branch],
      confirmToken: "tok-xyz",
    };
    expect(msg.type).toBe("superResidueList");
    if (msg.type !== "superResidueList") return;
    expect(msg.branches[0]?.unmerged).toBe(true);
    expect(msg.confirmToken).toBe("tok-xyz");
  });
});