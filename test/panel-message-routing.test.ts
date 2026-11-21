/**
 * 阶段 7（panel.ts 拆分收尾）等价性守卫。
 *
 * `handleWebviewMessage` 从 83 个 case 的巨型 switch 改成了「薄入口 + 4 个
 * 分域分派函数」。这是行为不变重构，硬指标是「每个 case 仍然存在且实现不变」。
 * 本测试把重构前的 case 类型清单（逐字提取自原 switch）固化成常量，并断言：
 *   ① 薄入口的 case 清单 == 固化清单；
 *   ② 4 个分域函数的 case 清单之和 == 固化清单；
 *   ③ 每个域精确包含预期 case（多一个/少一个都红灯）。
 *
 * 任何新增/删除/改名的消息类型都必须显式更新这里——防止有人借重构偷偷
 * 增删 case 或把某个 case 搬丢（静默 drop 是最危险的回归）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(path.join(here, "..", "src", "panel", "panel.ts"), "utf8");

/** 重构前从原 switch 逐字提取的 83 个 case 类型（源码顺序），外加多仓库协作
 * 新增的 setSessionRoots = 84 个。 */
const EXPECTED_CASES = [
  "ready", "sendPrompt", "queueAction", "resolveContext", "stopSubagent", "superAgent",
  "superRetryWave", "superRetryFailed", "requestSuperResidueList", "superResidueHandle",
  "cancel", "newSession", "setModel", "setThink", "openLocation", "openExternal",
  "respondApproval", "answerQuestions", "respondProfileSwitch", "respondSuperResidueConfirm",
  "revertTool", "applyHunkSelection", "restoreCheckpoint", "requestTurnChanges",
  "revertTurnFile", "openDiff", "runInTerminal", "searchFiles", "setSessionRoots", "stageFiles",
  "pickAttachments", "openImage", "saveAuth", "clearAuth", "activateProfile", "deleteProfile",
  "setOnboardingDismissed", "loadSession", "deleteSession", "setSessionFlags", "renameSession",
  "refreshAuth", "refreshModels", "restartCli", "openSettings", "setHostSettings",
  "listMcpServers", "saveMcpServers", "mcpStatus", "fetchModelMetadata", "cancelModelMetadata",
  "listAssets", "readAsset", "saveAsset", "createAsset", "deleteAsset", "generateAsset",
  "listMemory", "readMemoryFile", "saveMemoryFile", "appendMemoryFact", "deleteMemoryFacts",
  "createProjectMemory", "applyMemoryCandidates", "dismissMemoryCandidates", "openMemoryFile",
  "generateKnowledge", "setKnowledgeInjection", "openKnowledgeFile", "regenerate",
  "deleteUserMessage", "editAndResend", "exportSession", "enhancePrompt", "cancelEnhance",
  "toastAction", "togglePlanItem", "exportToolOutput", "qqSettingsPatch", "qqTaskAction",
  "qqConfigAction", "qqUserAction", "qqManagedSetup", "qqTakeover",
] as const;

/** 4 域的精确划分（阶段 7 的设计结论，逐域固化）。 */
const DOMAIN_CASES = {
  handleSessionMessage: [
    "ready", "sendPrompt", "queueAction", "resolveContext", "cancel", "newSession", "setModel",
    "setThink", "openLocation", "openExternal", "runInTerminal", "searchFiles", "setSessionRoots", "stageFiles",
    "pickAttachments", "openImage", "saveAuth", "clearAuth", "activateProfile", "deleteProfile",
    "setOnboardingDismissed", "loadSession", "deleteSession", "setSessionFlags", "renameSession",
    "refreshAuth", "refreshModels", "restartCli", "openSettings", "setHostSettings",
    "listMcpServers", "saveMcpServers", "mcpStatus", "fetchModelMetadata", "cancelModelMetadata",
    "listAssets", "readAsset", "saveAsset", "createAsset", "deleteAsset", "generateAsset",
    "listMemory", "readMemoryFile", "saveMemoryFile", "appendMemoryFact", "deleteMemoryFacts",
    "createProjectMemory", "applyMemoryCandidates", "dismissMemoryCandidates", "openMemoryFile",
    "generateKnowledge", "setKnowledgeInjection", "openKnowledgeFile", "regenerate",
    "deleteUserMessage", "editAndResend", "exportSession", "enhancePrompt", "cancelEnhance",
    "toastAction", "exportToolOutput",
  ],
  handleApprovalMessage: [
    "respondApproval", "answerQuestions", "respondProfileSwitch", "revertTool",
    "applyHunkSelection", "restoreCheckpoint", "requestTurnChanges", "revertTurnFile", "openDiff",
    "togglePlanItem",
  ],
  handleSuperMessage: ["stopSubagent", "superAgent", "superRetryWave", "superRetryFailed", "requestSuperResidueList", "superResidueHandle", "respondSuperResidueConfirm"],
  handleQqMessage: [
    "qqSettingsPatch", "qqTaskAction", "qqConfigAction", "qqUserAction", "qqManagedSetup",
    "qqTakeover",
  ],
} as const;

/** 换行 + 两空格缩进的 private 方法标记（避免源码里出现转义字符）。 */
const NEXT_PRIVATE = String.fromCharCode(10) + "  private ";

/** 取某个 private 方法从签名到下一个 private 方法之间的源码。 */
function methodBody(signature: string): string {
  const start = panelSource.indexOf(signature);
  if (start < 0) throw new Error(`panel.ts 找不到方法：${signature}`);
  const bodyStart = start + signature.length;
  const next = panelSource.indexOf(NEXT_PRIVATE, bodyStart);
  return panelSource.slice(start, next < 0 ? panelSource.length : next);
}

function caseLabels(source: string): string[] {
  return [...source.matchAll(/^      case "([^"]+)":/gm)].map((m) => m[1]!);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("阶段 7 · Webview 消息路由分域等价性", () => {
  const routerBody = methodBody("private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {");
  const routerCases = caseLabels(routerBody);

  it("薄入口的 case 清单 == 重构前的 83 个 + 后续新增（多仓库协作 setSessionRoots）", () => {
    expect(routerCases).toHaveLength(84);
    expect(sorted(routerCases)).toEqual(sorted(EXPECTED_CASES));
  });

  it("4 个分域函数的 case 之和 == 薄入口清单（没有 case 在搬运中丢失或被吞掉）", () => {
    const all: string[] = [];
    for (const method of Object.keys(DOMAIN_CASES)) {
      const sig = `private async ${method}(msg: WebviewToHost): Promise<void> {`;
      all.push(...caseLabels(methodBody(sig)));
    }
    expect(sorted(all)).toEqual(sorted(routerCases));
  });

  it("每个域精确包含预期 case（跨域归属变化必须显式讨论）", () => {
    for (const [method, expected] of Object.entries(DOMAIN_CASES)) {
      const sig = `private async ${method}(msg: WebviewToHost): Promise<void> {`;
      expect(sorted(caseLabels(methodBody(sig)))).toEqual(sorted(expected));
    }
  });

  it("case 无重复：薄入口里每个 wire 类型只出现一次", () => {
    // 本轮是纯移动：不新增 case，也不需要改 WebviewToHost。若有人把新消息
    // 直接塞进分域函数却没进薄入口，上面第 2 条会立刻失败。
    // 多仓库协作新增了 setSessionRoots（见 EXPECTED_CASES），计数随之 +1。
    expect(new Set(routerCases).size).toBe(84);
  });
});
