/**
 * 看板「按波次」视图：运行组 → 波次 → 子会话行。
 *
 * 展开关系是**两级**：组用 DisclosureButton 折叠；组展开后波次只是分层标题
 * （不可再折叠），子会话行沿用既有 SuperSessionRow 的 openRow 单选展开。
 * 绝不让分组视图退化成一堆并列卡片 —— 那正是这个组件历史上反复修过的回归。
 *
 * 所有 chip 都带 shrink-0 + max-[380px]:hidden（或 truncate），保证窄屏下
 * 耗时与 chevron 不会被挤掉。状态是三重编码：图标形状 + 中文文案 + 颜色。
 * 数据全部来自 shared/super-board.ts 的纯聚合结果，缺失字段自然降级。
 */
import { Fragment, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Layers,
  Loader2,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import type {
  SuperBoardCounts,
  SuperBoardGroup,
  SuperBoardSession,
  SuperBoardWave,
} from "../../../shared/super-board";
import { ICON_INLINE, Chip, DisclosureButton } from "./ui";
import { t } from "../i18n";

/** HH:MM:SS。与 SuperAgentBoard 内同款格式化，仅用于 tooltip / 行内区间。 */
function formatBoardClock(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 时间区间文案：有头有尾给「A → B」，只有开始给「始于 A」，都没有给空。 */
function rangeText(startedAt: number | undefined, endedAt: number | undefined): string {
  const start = formatBoardClock(startedAt);
  const end = formatBoardClock(endedAt);
  if (start && end) return t("{0} → {1}", start, end);
  if (start) return t("始于 {0}", start);
  return "";
}

/** 一层统计的状态 chip 簇（只为非零项渲染；三重编码：形状 + 文案 + 色调）。 */
function StatusChips({ counts, compact = false }: { counts: SuperBoardCounts; compact?: boolean }) {
  const hide = compact ? "max-[380px]:hidden" : "";
  return (
    <>
      {counts.done > 0 && (
        <Chip tone="success" className={hide} title={t("{0} 个完成", counts.done)}>
          <Check className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 完成", counts.done)}</span>
        </Chip>
      )}
      {counts.failed > 0 && (
        <Chip tone="danger" className={hide} title={t("{0} 个失败", counts.failed)}>
          <X className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 失败", counts.failed)}</span>
        </Chip>
      )}
      {counts.retrying > 0 && (
        <Chip tone="primary" className={hide} title={t("{0} 个重试中", counts.retrying)}>
          <RotateCcw className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 重试中", counts.retrying)}</span>
        </Chip>
      )}
      {counts.blocked > 0 && (
        <Chip tone="warning" className={hide} title={t("{0} 个阻塞", counts.blocked)}>
          <CircleHelp className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 阻塞", counts.blocked)}</span>
        </Chip>
      )}
      {counts.running > 0 && (
        <Chip tone="primary" className={hide} title={t("{0} 个运行中", counts.running)}>
          <Loader2 className="size-2.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 运行中", counts.running)}</span>
        </Chip>
      )}
      {counts.cancelled > 0 && (
        <Chip tone="muted" className={hide} title={t("{0} 个已中断", counts.cancelled)}>
          <Square className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{t("{0} 已中断", counts.cancelled)}</span>
        </Chip>
      )}
    </>
  );
}

/** 波次分层标题（不可折叠；只做视觉分组）。 */
function WaveHeader({ wave }: { wave: SuperBoardWave }) {
  const range = rangeText(wave.startedAt, wave.endedAt);
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-ui-micro text-muted-foreground">
      <Layers className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 font-medium text-foreground">
        {wave.wave === 0 ? t("未分组") : t("第 {0} 波", wave.wave)}
      </span>
      <Chip tone="muted" className="max-[380px]:hidden" title={t("{0} 个任务", wave.counts.total)}>
        <span className="tabular-nums">{wave.counts.total}</span>
      </Chip>
      <StatusChips counts={wave.counts} compact />
      {range && (
        <span className="ml-auto shrink-0 text-ui-micro tabular-nums text-muted-foreground" title={range}>
          {range}
        </span>
      )}
    </div>
  );
}

/**
 * 按运行组 + 波次渲染看板行。
 *
 * `renderRow` 由看板传入（复用 SuperSessionRow 及其全部 pending 状态），本组件
 * 只负责分组结构与组级 / 波次级摘要 —— 单一职责，行展开仍由看板的 openRow 单选控制。
 */
export function SuperBatchGroups({
  groups,
  renderRow,
}: {
  groups: readonly SuperBoardGroup[];
  renderRow: (session: SuperBoardSession) => ReactNode;
}) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (runId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  if (groups.length === 0) {
    return (
      <div className="px-2 py-3 text-ui-caption text-muted-foreground">
        {t("暂无运行组")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const open = openGroups.has(group.runId);
        const label = group.isDefault ? t("默认运行组") : group.runId;
        const toggleLabel = open ? t("收起运行组 {0}", label) : t("展开运行组 {0}", label);
        const range = rangeText(group.startedAt, group.endedAt);
        return (
          <div key={group.runId} className="shrink-0">
            <DisclosureButton
              expanded={open}
              aria-label={toggleLabel}
              title={toggleLabel}
              hoverSurface="self"
              className="w-full rounded-sm px-2 py-1.5"
              onClick={() => toggleGroup(group.runId)}
            >
              {open ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
              <span className="min-w-0 truncate font-medium" title={group.runId}>
                {label}
              </span>
              <Chip tone="muted" title={t("{0} 个任务", group.counts.total)}>
                <span className="tabular-nums">{group.counts.total}</span>
              </Chip>
              <StatusChips counts={group.counts} />
              {range && (
                <span
                  className="ml-auto shrink-0 text-ui-micro tabular-nums text-muted-foreground max-[380px]:hidden"
                  title={range}
                >
                  {range}
                </span>
              )}
            </DisclosureButton>
            {open && (
              <div className="border-l border-border/50 pl-1.5">
                {group.waves.map((wave) => (
                  <div key={wave.wave} className="shrink-0">
                    <WaveHeader wave={wave} />
                    <div className="divide-y divide-border/40">
                      {wave.sessions.map((session) => (
                        <Fragment key={session.id}>{renderRow(session)}</Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
