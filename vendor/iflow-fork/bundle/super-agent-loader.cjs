/**
 * super-agent-loader.cjs
 *
 * Decision layer for the super-agent-tool-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, byte-for-byte):
 *   The built-in tool base class `Li` is
 *
 *     Li=class{name;displayName;description;icon;kind;parameterSchema;
 *       isOutputMarkdown;canUpdateOutput;aliases;
 *       constructor(A,e,t,r,n,s,a=!0,o=!1,l=[]){...}
 *       get schema(){return{name:this.name,description:this.description,
 *                            parameters:this.parameterSchema}}
 *       validateToolParams(A){return null}
 *       getDescription(A){return JSON.stringify(A)}
 *       shouldConfirmExecute(A,e){return Promise.resolve(!1)}
 *       toolLocations(A){return[]}}
 *
 *   Every tool is registered inside Config.createToolRegistry() through the
 *   local registrar `t(r,...n)` -> `new r(...n)` + `registry.registerTool`.
 *   The patched call site (see apply-patch.mjs) hands this module the four
 *   in-scope minified bindings:
 *
 *     base  = Li  (tool base class)
 *     kinds = Fi  ({Read,Edit,Delete,Move,Search,Execute,Think,Fetch,Other})
 *     icons = Mi  ({FileSearch,Folder,Globe,Hammer,LightBulb,Pencil,Regex,
 *                   Terminal})
 *     types = Dt  (Gemini schema Type enum: STRING/OBJECT/ARRAY/BOOLEAN/...)
 *
 *   and registers the returned class only when IFLOW_SUPER_TOOL=1.
 *
 * Why execute() only acknowledges (after validating):
 *   Dispatching a child session means spawning a separate CLI process, an
 *   ACP session and a git worktree — all of that lives in the HOST, not in
 *   the CLI. The CLI only has to make the tool call visible on the wire: the
 *   ACP adapter emits `tool_call` / `tool_call_update` with `toolName` and
 *   `args` (the parsed parameter object), so the host reads `tasks` from
 *   those args and starts the children itself. Returning a fixed ack keeps
 *   the model's tool loop moving without inventing a second dispatch channel
 *   inside the CLI. The ack shape `{llmContent, returnDisplay}` is the same
 *   contract every other simple tool returns (verified against todo_write /
 *   list_directory / web_search).
 *
 *   The ack is only returned after `validateToolParams` passes. Invalid
 *   parameters make `execute` throw `Invalid parameters: …`, which the tool
 *   executor turns into `functionResponse.error` and an ACP `failed` status —
 *   the model sees the concrete reason in the SAME turn and can correct the
 *   call itself instead of being told "accepted" for a payload the host can
 *   never dispatch.
 *
 * shouldConfirmExecute() returns false on purpose: the tool performs no I/O
 * and no side effect inside the CLI (the host owns the actual dispatch), so
 * asking the user for a per-call approval would only add a click that cannot
 * change anything. NOTE: with the CLI's "smart approval" mode the smart
 * engine still evaluates every tool call and may ask — that gate lives
 * outside shouldConfirmExecute and is not bypassed here.
 *
 * NOTE: this module MUST NOT write to stdout — in ACP mode stdout carries the
 * NDJSON protocol stream and a stray line corrupts the wire.
 */

"use strict";

const TOOL_NAME = "super-agent";
const DISPLAY_NAME = "Super Agent";

const DESCRIPTION =
  "Delegate work to one or more child sessions, or manage existing ones. Each child session runs in its own git " +
  "worktree on its own branch, so several children can change this project at once without stepping on each other. " +
  "Pass EITHER `tasks` to dispatch children, OR `actions` to manage children already on the board. One call " +
  "carries one kind: tasks OR actions, never both. Each task needs a self-contained `task` brief plus a required " +
  "short `title` and optional `attachments` paths; it can also carry `id` (a stable block-unique label), " +
  "`dependsOn` (an array of `id`/`title` labels this task waits for), `batch` (a 1-based batch number for " +
  "batch-mode waves), and `maxAttempts` (the maximum attempts allowed for this task). Use EITHER `dependsOn` " +
  "OR `batch` across a single call, never both. The host performs the real work and reports results back to you; " +
  "this call only returns an acknowledgement. Prefer this tool over writing a `super-agent` / " +
  "`super-agent-actions` fenced code block by hand.";

const ACK = "Delegation request accepted.";

/**
 * Build the tool class from the bindings injected at the anchor.
 * Returns null for unusable input so the call site can skip registration.
 */
function create(bag) {
  if (!bag || typeof bag.base !== "function") return null;
  const Base = bag.base;
  const kinds = bag.kinds || {};
  const icons = bag.icons || {};
  const types = bag.types || {};

  const T_OBJECT = types.OBJECT || "OBJECT";
  const T_STRING = types.STRING || "STRING";
  const T_ARRAY = types.ARRAY || "ARRAY";
  const T_BOOLEAN = types.BOOLEAN || "BOOLEAN";
  const T_NUMBER = types.NUMBER || "NUMBER";

  class SuperAgentTool extends Base {
    static Name = TOOL_NAME;
    static DisplayName = DISPLAY_NAME;

    constructor(config) {
      super(
        TOOL_NAME,
        DISPLAY_NAME,
        DESCRIPTION,
        icons.Hammer || "hammer",
        kinds.Other || "other",
        {
          type: T_OBJECT,
          properties: {
            tasks: {
              type: T_ARRAY,
              description:
                "Tasks to delegate. Each one becomes an independent child session with its own git worktree. " +
                "Use this OR `actions`, never both in one call.",
              items: {
                type: T_OBJECT,
                properties: {
                  title: {
                    type: T_STRING,
                    description:
                      "Required short label for the child session (keep it under 24 characters). A task whose title is missing or blank is rejected.",
                  },
                  task: {
                    type: T_STRING,
                    description:
                      "Self-contained brief: the child cannot see this conversation, so state the goal, the relevant files, what done means, and how to verify it.",
                  },
                  attachments: {
                    type: T_ARRAY,
                    description:
                      "Optional extra files the child needs, as workspace-relative or absolute paths.",
                    items: { type: T_STRING },
                  },
                  id: {
                    type: T_STRING,
                    description:
                      "Optional stable label (unique within this call). dependsOn resolves against id first, then title.",
                  },
                  dependsOn: {
                    type: T_ARRAY,
                    description:
                      "Labels (id or title) of tasks this one waits for. Use either dependsOn or batch in one call, not both.",
                    items: { type: T_STRING },
                  },
                  batch: {
                    type: T_NUMBER,
                    description:
                      "1-based batch number for batch-mode waves. Use either batch or dependsOn in one call, not both.",
                  },
                  maxAttempts: {
                    type: T_NUMBER,
                    description:
                      "Maximum number of attempts allowed for this task before retry policy stops retrying it.",
                  },
                },
                // title 与 task 都必填：宿主 shared/super-agent.ts 对 trim 后为空
                // 的 title 一律拒绝（绝不拿 task 正文顶替标题）。schema 必须与宿主
                // 同口径，否则模型会以为 title 可省，派发时被宿主整条拒掉。
                required: ["task", "title"],
              },
            },
            // 子会话管理动作与 `super-agent-actions` 围栏协议逐字段同形：宿主收到
            // 这个数组后直接走动作执行链路（retry/cancel/answer/cleanup），不再要求
            // 模型去调用一个 registry 里并不存在的 actions 工具。
            actions: {
              type: T_ARRAY,
              description:
                "Management actions to apply to child sessions already on the board. " +
                "Use this OR `tasks`, never both in one call. The host performs each action and reports back.",
              items: {
                type: T_OBJECT,
                properties: {
                  action: {
                    type: T_STRING,
                    description: "One of: retry, cancel, answer, cleanup.",
                    enum: ["retry", "cancel", "answer", "cleanup"],
                  },
                  sessionId: {
                    type: T_STRING,
                    description: "The exact child session id shown on the board.",
                  },
                  answers: {
                    type: T_OBJECT,
                    description:
                      "Required for `answer`: map of question header to the answer (a string for single choice, an array of strings for multi choice).",
                  },
                  keepBranch: {
                    type: T_BOOLEAN,
                    description:
                      "Optional for `cleanup`: keep the unmerged branch instead of deleting it.",
                  },
                },
                required: ["action", "sessionId"],
              },
            },
          },
          // 不强制 required：tasks 与 actions 二选一，由 validateToolParams 兜底校验。
          // 不用 anyOf 是因为 CLI 侧 schema 校验器对它的支持未验证，最小改动更稳。
        },
        true,
        false,
        []
      );
      this.config = config;
    }

    /**
     * 严格校验工具参数。
     *
     * 返回 null = 合法；返回字符串 = 具体的非法原因（带索引与字段名），
     * 由 {@link execute} 抛给模型，让它在同一轮里自行修正后重派。
     *
     * 规则（与宿主 shared/super-agent.ts 的载荷语义保持一致，但这里是**工具层
     * 的第一道闸门**：参数不合法时 execute 直接报错，ACP 把工具调用标记为
     * failed，模型立刻知道「这次没派出去」，而不是收到一个假的 ack 后继续
     * 往下写）。
     *
     *  - tasks / actions 二选一（两者同时非空直接报错），被选中的那个必须是非空数组；
     *  - 每个 task 必须是非数组对象；
     *  - `task` 必须是非空字符串；
     *  - `title` 必填：trim 后必须是非空字符串（与宿主同口径，绝不回退到 task 正文）；
     *  - `attachments` 可选，但存在时必须是字符串数组；
     *  - `id` 可选，但存在时必须是字符串；
     *  - `dependsOn` 可选，但存在时必须是字符串数组；
     *  - `batch` / `maxAttempts` 可选，但存在时必须是正整数（1 基）。
     *
     * 逐字段只校验**类型**；跨任务的语义（dependsOn 引用是否存在、dependsOn 与
     * batch 是否混用）由共享层 planSuperWaves 出 issue，loader 不重复实现。
     */
    validateToolParams(params) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return "parameters must be an object with either tasks or actions";
      }
      // 流式修复层（stream-toolcall-repair-loader.cjs）发现 super-agent 载荷
      // 被截断时不会本地修补，而是把该哨兵对象交回这里：当场判失败，模型在
      // 同一轮收到明确原因后重发完整载荷，而不是派发一个 title 丢失 / 正文被
      // 砍断的任务。
      if (params.__iflowStreamTruncated === true) {
        return "tool-call arguments were truncated in the stream; re-send the complete tasks payload";
      }
      const hasTasksField = params.tasks !== undefined && params.tasks !== null;
      const hasActionsField = params.actions !== undefined && params.actions !== null;
      // 派发与管理二选一：两个都空（或都没给）时明确报错，避免模型传
      // `{"tasks":[]}` 后静默什么都没发生。这里正是放宽 schema required 后的
      // 兜底闸门。
      if (!hasTasksField && !hasActionsField) {
        return "either tasks or actions must be a non-empty array";
      }
      // tasks 与 actions 同时非空时直接报错：旧实现把这种载荷按派发处理，
      // 管理动作被静默丢弃（或反过来），调用方以为两件事都做了。只新增「两边
      // 都有实质内容」这一条拒绝；其余组合（如 tasks 为空数组）仍走下面的
      // 逐字段校验，行为不变。
      if (
        hasTasksField && Array.isArray(params.tasks) && params.tasks.length > 0 &&
        hasActionsField && Array.isArray(params.actions) && params.actions.length > 0
      ) {
        return "tasks and actions are mutually exclusive: pass either tasks (dispatch) or actions (manage), never both in one call";
      }
      if (hasTasksField) {
        if (!Array.isArray(params.tasks)) return "tasks must be an array";
        if (params.tasks.length === 0) return "tasks must be a non-empty array";
        for (let i = 0; i < params.tasks.length; i++) {
          const task = params.tasks[i];
          if (!task || typeof task !== "object" || Array.isArray(task)) {
            return `tasks[${i}] must be an object`;
          }
          if (typeof task.task !== "string" || task.task.trim().length === 0) {
            return `tasks[${i}].task must be a non-empty string`;
          }
          // title 必填：缺失 / 非字符串 / trim 后为空一律拒绝。与宿主
          // shared/super-agent.ts 的 parseSuperDelegationPayload 同口径 —— 这里
          // 刻意不实现「用 task 正文顶替 title」的兜底（那会推翻 5055190 的设计）。
          if (typeof task.title !== "string" || task.title.trim().length === 0) {
            return `tasks[${i}].title is required and must be a non-empty string`;
          }
          if (task.attachments !== undefined) {
            if (!Array.isArray(task.attachments)) {
              return `tasks[${i}].attachments must be an array of strings`;
            }
            for (let j = 0; j < task.attachments.length; j++) {
              if (typeof task.attachments[j] !== "string") {
                return `tasks[${i}].attachments[${j}] must be a string`;
              }
            }
          }
          // 依赖 / 批次 / 尝试次数字段的**类型**闸门（共享层 planSuperWaves 仍负责
          // 跨任务的语义校验，如 dependsOn 引用是否存在、dependsOn 与 batch 混用）：
          // 这里只挡「类型写坏」——网关或宿主若拿到字符串型的 batch 会静默算错波次。
          if (task.id !== undefined && typeof task.id !== "string") {
            return `tasks[${i}].id must be a string`;
          }
          if (task.dependsOn !== undefined) {
            if (!Array.isArray(task.dependsOn)) {
              return `tasks[${i}].dependsOn must be an array of strings`;
            }
            for (let j = 0; j < task.dependsOn.length; j++) {
              if (typeof task.dependsOn[j] !== "string") {
                return `tasks[${i}].dependsOn[${j}] must be a string`;
              }
            }
          }
          if (
            task.batch !== undefined &&
            !(Number.isInteger(task.batch) && task.batch >= 1)
          ) {
            return `tasks[${i}].batch must be a positive integer (1-based)`;
          }
          if (
            task.maxAttempts !== undefined &&
            !(Number.isInteger(task.maxAttempts) && task.maxAttempts >= 1)
          ) {
            return `tasks[${i}].maxAttempts must be a positive integer`;
          }
        }
      }
      if (hasActionsField) {
        if (!Array.isArray(params.actions)) return "actions must be an array";
        if (params.actions.length === 0) return "actions must be a non-empty array";
        const allowed = ["retry", "cancel", "answer", "cleanup"];
        for (let i = 0; i < params.actions.length; i++) {
          const action = params.actions[i];
          if (!action || typeof action !== "object" || Array.isArray(action)) {
            return `actions[${i}] must be an object`;
          }
          if (typeof action.action !== "string" || !allowed.includes(action.action)) {
            return `actions[${i}].action must be one of ${allowed.join(", ")}`;
          }
          if (typeof action.sessionId !== "string" || action.sessionId.trim().length === 0) {
            return `actions[${i}].sessionId must be a non-empty string`;
          }
          if (
            action.action === "answer" &&
            (!action.answers || typeof action.answers !== "object" || Array.isArray(action.answers))
          ) {
            return `actions[${i}].answers must be an object for answer actions`;
          }
          if (action.keepBranch !== undefined && typeof action.keepBranch !== "boolean") {
            return `actions[${i}].keepBranch must be a boolean`;
          }
        }
      }
      return null;
    }

    /**
     * The ACP adapter uses getDescription(params) as the tool-call title.
     * The base implementation is JSON.stringify(params) — a whole payload in
     * the title — so keep it to a short label. Management calls must not dump
     * their answers/briefs into the tool title either.
     */
    getDescription(params) {
      if (params && Array.isArray(params.actions) && params.actions.length > 0) {
        const count = params.actions.length;
        return count === 1 ? "Manage 1 child session action" : `Manage ${count} child session actions`;
      }
      const count = params && Array.isArray(params.tasks) ? params.tasks.length : 0;
      if (count === 1) return "Delegate 1 task";
      return `Delegate ${count} tasks`;
    }

    /** No side effect inside the CLI: the host owns the actual dispatch. */
    shouldConfirmExecute() {
      return Promise.resolve(false);
    }

    /**
     * 参数合法才 ack。
     *
     * 内核的执行器（bundle 实证 0.5.19：`_Se` 里 `await n.execute(e.args,l)`
     * 没有前置 validate）直接调用 execute；抛错会被它 catch 成
     * `functionResponse.response.error`，ACP 侧把工具调用标成 failed。
     * 这正是模型自我修正需要的反馈通道：旧实现对任何参数都回 ack，模型
     * 以为派发成功，宿主解析失败只能弹 toast，双方都停在错误里。
     */
    async execute(params) {
      const invalid = this.validateToolParams(params);
      if (invalid) {
        throw new Error(`Invalid parameters: ${invalid}`);
      }
      return { llmContent: ACK, returnDisplay: ACK };
    }
  }

  return SuperAgentTool;
}

module.exports = { create, TOOL_NAME };
