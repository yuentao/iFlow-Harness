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
  "Pass EITHER `tasks` (each with a self-contained `task` brief, an optional short `title`, and optional " +
  "`attachments` paths) to dispatch children, OR `actions` (each with an `action` of retry/cancel/answer/cleanup " +
  "and a `sessionId`) to manage children already on the board. One call carries one kind: tasks OR actions, never both. " +
  "The host performs the real work and reports results back to you; this call only returns an acknowledgement. " +
  "Prefer this tool over writing a `super-agent` / `super-agent-actions` fenced code block by hand.";

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
                    description: "Short label for the child session (keep it under 24 characters).",
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
                },
                // title 是可选的短标签（宿主缺失时回退到 task 首行），只强制 task。
                required: ["task"],
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
     *  - tasks / actions 二选一，且被选中的那个必须是非空数组；
     *  - 每个 task 必须是非数组对象；
     *  - `task` 必须是非空字符串；
     *  - `title` 可选，但存在时必须是字符串；
     *  - `attachments` 可选，但存在时必须是字符串数组。
     */
    validateToolParams(params) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return "parameters must be an object with either tasks or actions";
      }
      const hasTasksField = params.tasks !== undefined && params.tasks !== null;
      const hasActionsField = params.actions !== undefined && params.actions !== null;
      // 派发与管理二选一：两个都空（或都没给）时明确报错，避免模型传
      // `{"tasks":[]}` 后静默什么都没发生。这里正是放宽 schema required 后的
      // 兜底闸门。
      if (!hasTasksField && !hasActionsField) {
        return "either tasks or actions must be a non-empty array";
      }
      // 两个字段同时出现时不在这里额外禁止：宿主的载荷分流对它有既有语义
      // （非空 actions 且没有非空 tasks 时按管理动作处理），loader 只负责
      // 校验各自的结构。
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
          if (task.title !== undefined && typeof task.title !== "string") {
            return `tasks[${i}].title must be a string`;
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
