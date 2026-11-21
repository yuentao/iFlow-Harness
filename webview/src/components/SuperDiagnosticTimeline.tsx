/**
 * 看板「诊断」视图：跨子会话的诊断事件时间线。
 *
 * 事件由 shared/super-board.ts 的 collectSuperBoardDiagnosticTimeline 汇总并
 * 按时间倒序稳定排序；这里只负责呈现：时间 / 事件类型 / 级别 / 一句话消息，
 * 有 detail 时用 DisclosureButton 就地展开（不弹 portal，自然跟随看板 inert）。
 *
 * 级别是三重编码：图标形状 + 中文文案 + 颜色。事件类型是稳定枚举，已知值过
 * t() 字典；**事件消息与 detail 是子会话产出的原文，绝不过字典**。
 */
import { useState } from "react";
import { AlertTriangle, Bug, Info, XCircle } from "lucide-react";
import type {
  SuperBoardDiagnosticSummary,
  SuperBoardDiagnosticTimelineEntry,
} from "../../../shared/super-board";
import { Chip, DisclosureButton } from "./ui";
import { t } from "../i18n";

/** HH:MM:SS，与看板其余时间显示同款。 */
function formatEventClock(at: number): string {
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 级别 → 形状 + 文案（中文源）+ 文字色调。颜色只是第三重冗余。 */
const LEVEL_VISUAL: Record<
  string,
  { icon: React.ReactNode; label: string; textClass: string; chipTone: "info" | "warning" | "danger" | "muted" }
> = {
  info: { icon: <Info className="size-3 shrink-0" />, label: "信息", textClass: "text-info", chipTone: "info" },
  warn: { icon: <AlertTriangle className="size-3 shrink-0" />, label: "警告", textClass: "text-warning", chipTone: "warning" },
  warning: { icon: <AlertTriangle className="size-3 shrink-0" />, label: "警告", textClass: "text-warning", chipTone: "warning" },
  error: { icon: <XCircle className="size-3 shrink-0" />, label: "错误", textClass: "text-destructive", chipTone: "danger" },
  fatal: { icon: <XCircle className="size-3 shrink-0" />, label: "错误", textClass: "text-destructive", chipTone: "danger" },
  critical: { icon: <XCircle className="size-3 shrink-0" />, label: "错误", textClass: "text-destructive", chipTone: "danger" },
  debug: { icon: <Bug className="size-3 shrink-0" />, label: "调试", textClass: "text-muted-foreground", chipTone: "muted" },
};
const LEVEL_FALLBACK = LEVEL_VISUAL.info!;

/** 已知事件类型 → 中文源文案；未知类型直接显示原文（系统枚举，不是用户内容）。 */
const KIND_TEXT: Record<string, string> = {
  dispatch: "派发",
  dispatched: "派发",
  start: "启动",
  started: "启动",
  retry: "重试",
  retried: "重试",
  tool: "工具调用",
  error: "错误",
  failed: "失败",
  blocked: "阻塞",
  context: "上下文",
  integration: "集成",
  complete: "完成",
  completed: "完成",
  cancel: "中断",
  cancelled: "中断",
  approval: "审批",
};

function kindLabel(kind: string): string {
  const source = KIND_TEXT[kind];
  return source ? t(source) : kind;
}

/** 单条事件：有 detail 才可展开，展开态本地单选（互不影响）。 */
function DiagnosticEntry({
  entry,
  index,
}: {
  entry: SuperBoardDiagnosticTimelineEntry;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const visual = LEVEL_VISUAL[(entry.level ?? "").toLowerCase()] ?? LEVEL_FALLBACK;
  const clock = formatEventClock(entry.at);
  const hasDetail = typeof entry.detail === "string" && entry.detail.length > 0;
  const expandLabel = open ? t("收起诊断详情") : t("展开诊断详情");

  return (
    <div className="shrink-0" data-diag-index={index}>
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
        {hasDetail ? (
          <DisclosureButton
            expanded={open}
            aria-label={expandLabel}
            title={expandLabel}
            hoverSurface="row"
            className="min-w-0 flex-1 gap-1.5"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground" title={t("事件时间")}>
              {clock || "--:--:--"}
            </span>
            <span className={`flex shrink-0 items-center gap-1 ${visual.textClass}`}>
              {visual.icon}
              <span className="text-ui-micro font-medium">{t(visual.label)}</span>
            </span>
            <span className="shrink-0 text-ui-micro font-medium text-foreground">
              {kindLabel(entry.kind)}
            </span>
            {/* 子会话产出的原文：不过字典、窄屏 truncate、不挤掉级别与 chevron。 */}
            <span className="min-w-0 flex-1 truncate text-ui-caption text-muted-foreground" title={entry.message}>
              {entry.message}
            </span>
          </DisclosureButton>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground" title={t("事件时间")}>
              {clock || "--:--:--"}
            </span>
            <span className={`flex shrink-0 items-center gap-1 ${visual.textClass}`}>
              {visual.icon}
              <span className="text-ui-micro font-medium">{t(visual.label)}</span>
            </span>
            <span className="shrink-0 text-ui-micro font-medium text-foreground">
              {kindLabel(entry.kind)}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui-caption text-muted-foreground" title={entry.message}>
              {entry.message}
            </span>
          </div>
        )}
      </div>
      {hasDetail && open && (
        <div className="break-words whitespace-pre-wrap px-2 pb-2 pl-8 text-ui-caption text-muted-foreground">
          {entry.detail}
        </div>
      )}
    </div>
  );
}

/** 跨子会话诊断时间线主体（含顶部汇总）。 */
export function SuperDiagnosticTimeline({
  entries,
  summary,
}: {
  entries: readonly SuperBoardDiagnosticTimelineEntry[];
  summary: SuperBoardDiagnosticSummary;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1.5 text-ui-micro text-muted-foreground">
        <span className="font-medium text-foreground">{t("诊断事件")}</span>
        <Chip tone="muted" title={t("共 {0} 条", summary.total)}>
          <span className="tabular-nums">{t("共 {0} 条", summary.total)}</span>
        </Chip>
        {summary.byKind.map((item) => (
          <Chip key={item.kind} tone="info" className="max-[380px]:hidden" title={t("{0} 条 {1}", item.count, kindLabel(item.kind))}>
            <span className="tabular-nums">{kindLabel(item.kind)} {item.count}</span>
          </Chip>
        ))}
        {summary.lastError && (
          <span className="min-w-0 truncate text-destructive" title={summary.lastError.message}>
            {t("最近错误：{0}", summary.lastError.message)}
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="px-2 py-3 text-ui-caption text-muted-foreground">
          {t("暂无诊断事件")}
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {entries.map((entry, index) => (
            <DiagnosticEntry
              key={`${entry.sessionId}:${entry.at}:${entry.kind}:${index}`}
              entry={entry}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}
