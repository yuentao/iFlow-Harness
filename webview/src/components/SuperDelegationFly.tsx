/**
 * 委派成功 → 飞入看板的一次性 UX 动效。
 *
 * 触发信号是**权威的** `superSessions` 新增 id（对比上一次快照），不是 toast：
 * toast 会消失，而且它是通用提示，不能当 DOM 动画的锚点。每个会话独立记录
 * 上一次见过的 id 集合，所以切换会话 / 历史恢复（新 id 但属于另一个主会话）
 * 不会被误判成「刚委派成功」；`restored: true` 的历史子会话显式跳过。
 *
 * 起点是转录里最近一张委派卡（`data-super-delegation-origin`，见
 * SuperDirectiveCard.tsx），终点是顶栏看板控件的 `getBoundingClientRect()`。
 * 整批 N 个子会话只合成一个飞入体（徽标显示 N），同一时刻最多一个飞入体，
 * 避免连续快照刷屏。
 *
 * 动效元素 `createPortal` 到 document.body：看板面板/待答条已经这么做了
 * （陷阱 #22：`.acrylic` 的 backdrop-filter 会给 fixed 后代建立包含块并裁切）。
 * 它 `aria-hidden` + `pointer-events: none`，不改变任何真实控件/DOM 语义。
 * 播完（animationend 或兜底定时器）立即卸载，组件卸载也清定时器，无泄漏。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Users } from "lucide-react";
import type { SuperSessionUi } from "../../../shared/super-agent";
import { ICON_INLINE } from "./ui";

/** 委派卡上的起点标记（SuperDirectiveCard 给任务卡 / 工具调用卡挂）。 */
export const DELEGATION_ORIGIN_ATTR = "data-super-delegation-origin";

/** 飞入体尺寸：沿用 kit 的 28px 控件高度，不新增尺寸档位。 */
const FLY_SIZE = 28;
/** 与 styles.css 的 @keyframes super-delegation-fly 时长一致。 */
const FLY_DURATION_MS = 640;
/** animationend 没来时的兜底（jsdom / 动画被浏览器跳过）。 */
const FLY_CLEANUP_MS = FLY_DURATION_MS + 160;

interface FlyState {
  /** 每次飞入递增，作为 key 强制 CSS 动画重新播放。 */
  id: number;
  count: number;
  left: number;
  top: number;
  dx: number;
  dy: number;
}

interface SeenState {
  sessionId: string | null;
  ids: Set<string>;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SuperDelegationFly({
  sessions,
  activeSessionId,
  targetRef,
  onArrive,
}: {
  sessions: readonly SuperSessionUi[] | undefined;
  activeSessionId: string | null;
  targetRef: RefObject<HTMLElement | null>;
  /** 飞入抵达时回调（看板控件短暂高亮）；兜底定时器到期也会触发，幂等。 */
  onArrive?: () => void;
}) {
  const [fly, setFly] = useState<FlyState | null>(null);
  const seen = useRef<SeenState>({ sessionId: null, ids: new Set() });
  const nextId = useRef(0);
  const active = useRef(false);
  const arrived = useRef(false);
  const timer = useRef<number | null>(null);
  const onArriveRef = useRef(onArrive);
  onArriveRef.current = onArrive;

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    active.current = false;
    if (!arrived.current) {
      arrived.current = true;
      onArriveRef.current?.();
    }
    setFly(null);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  useEffect(() => {
    const list = sessions ?? [];
    const ids = new Set(list.map((s) => s.id));
    const prev = seen.current;
    // 会话切换 / 历史恢复：静默采纳新名册。这一帧里即便有「新」id 也不是
    // 本会话刚派发的飞入信号。
    if (prev.sessionId !== activeSessionId) {
      seen.current = { sessionId: activeSessionId, ids };
      return;
    }
    const fresh = list.filter((s) => !prev.ids.has(s.id) && s.restored !== true);
    seen.current = { sessionId: activeSessionId, ids };
    if (fresh.length === 0 || active.current || prefersReducedMotion()) return;

    const target = targetRef.current;
    if (!target) return;
    const origins = document.querySelectorAll(`[${DELEGATION_ORIGIN_ATTR}]`);
    const origin = origins.length > 0 ? origins[origins.length - 1] : null;
    if (!origin) return;

    const from = origin.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = to.left + to.width / 2;
    const endY = to.top + to.height / 2;

    active.current = true;
    arrived.current = false;
    nextId.current += 1;
    setFly({
      id: nextId.current,
      count: fresh.length,
      left: startX - FLY_SIZE / 2,
      top: startY - FLY_SIZE / 2,
      dx: endX - startX,
      dy: endY - startY,
    });
    timer.current = window.setTimeout(finish, FLY_CLEANUP_MS);
  }, [sessions, activeSessionId, targetRef, finish]);

  if (!fly) return null;

  const style = {
    left: `${fly.left}px`,
    top: `${fly.top}px`,
    "--fly-dx": `${fly.dx}px`,
    "--fly-dy": `${fly.dy}px`,
  } as CSSProperties;

  return createPortal(
    <div
      key={fly.id}
      data-testid="super-delegation-fly"
      aria-hidden="true"
      className="super-delegation-fly"
      style={style}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        finish();
      }}
    >
      <Users className={ICON_INLINE} />
      <span data-testid="super-delegation-fly-count" className="super-delegation-fly-count">
        {fly.count}
      </span>
    </div>,
    document.body,
  );
}
