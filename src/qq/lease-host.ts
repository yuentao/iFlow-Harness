/**
 * QQ 单活租约的宿主适配：把跨窗口共享的 `globalState` 接成
 * {@link QqLeaseStore}。纯判定逻辑在 `shared/qq-lease.ts`，本文件只做
 * 「脏数据归一化 + Memento 读写」，不引入任何状态机。
 */

import type * as vscode from "vscode";
import {
  QQ_LEASE_KEY,
  type QqLease,
  type QqLeaseStore,
} from "../../shared/qq-lease.js";

/** 把 globalState 里可能被人手改过的脏值收敛成合法租约。 */
function normalizeLease(raw: unknown): QqLease | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ownerId !== "string" || rec.ownerId.length === 0) return undefined;
  if (typeof rec.appId !== "string") return undefined;
  if (typeof rec.acquiredAt !== "number" || !Number.isFinite(rec.acquiredAt)) return undefined;
  if (typeof rec.renewedAt !== "number" || !Number.isFinite(rec.renewedAt)) return undefined;
  return {
    ownerId: rec.ownerId,
    appId: rec.appId,
    acquiredAt: rec.acquiredAt,
    renewedAt: rec.renewedAt,
    ...(typeof rec.pid === "number" && Number.isFinite(rec.pid) ? { pid: rec.pid } : {}),
  };
}

export function createQqMementoLeaseStore(memento: vscode.Memento): QqLeaseStore {
  return {
    get(): QqLease | undefined {
      return normalizeLease(memento.get<unknown>(QQ_LEASE_KEY));
    },
    async set(lease: QqLease | undefined): Promise<void> {
      // Memento 约定：update(key, undefined) 删除该键。不能先 unlink 再写 ——
      // 那会让另一个窗口在空窗期抢到租约后被旧值覆盖。
      await memento.update(QQ_LEASE_KEY, lease);
    },
  };
}
