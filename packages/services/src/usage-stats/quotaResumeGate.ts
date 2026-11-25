import {
  RESUME_CONTEXT_COMPACT_DELAY_MS,
  type CodingPlanResetScopeRequest,
  type CodingPlanResetStatusSnapshot,
  type QuotaWatchdogSettings,
  type ResumeIntent,
} from "@zcode/shared";
import { claimTargetForFailure, remainingPercentFromEntitlement } from "./quotaWatchdogDomain.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { quotaEligibleAt } from "#src/session/resumeIntentRepo.js";
import type { ResumeIntentRepo } from "#src/session/resumeIntentRepo.js";
import type { IUsageStatsService } from "./usageStats.js";

// v2 派发门（docs/quota-watchdog/spec.md §9.3，独立成文件以守住 800 行上限）：
// quota 意图派发前必须过 live 快照证实（核销前置：有卡即烧、成功当轮放行；绝不盲派发）；
// context 意图先 /compact 再续跑一次；transient 意图发现额度耗尽转 quota。
// 纯编排无状态：意图簿记（contextCompactArmed / selfCompactUntil）由宿主 service 注入。

const serviceLogger = createServiceLogger("quota-watchdog-gate");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** nextResetTime 未知时额度类意图的兜底重试间隔。 */
const QUOTA_FALLBACK_RETRY_MS = 10 * 60_000;
/** 派发门快照不可用时的守卫重排间隔（v2：不再盲目派发烧额度）。 */
const QUOTA_GATE_UNKNOWN_SNAPSHOT_RETRY_MS = 5 * 60_000;
/** 核销失败/对账未确认后的短重试间隔。 */
const QUOTA_CLAIM_RETRY_MS = 2 * 60_000;
/** 自发 /compact 后视为"本看门狗活动"的窗口（超窗后的活动才算用户自行活动）。 */
const SELF_COMPACT_ACTIVE_WINDOW_MS = 10 * 60_000;

export interface QuotaResumeGateDeps {
  resumeIntentRepo: ResumeIntentRepo;
  usageStatsService: IUsageStatsService;
  /** 核销当前可用的重置卡（宿主 claimResets：幂等 key 簿记 + /use 对账）。返回是否确认成功。 */
  claimResetCard: (
    snapshot: CodingPlanResetStatusSnapshot,
    scope: CodingPlanResetScopeRequest,
  ) => Promise<boolean>;
  /** context 意图首次过门：发 v4 compact 维护命令（idle 立即执行 / busy 进 FIFO）。 */
  requestCompact: (input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  /** 意图簿记（宿主持有，跨 tick / checkpoint 生命周期）： */
  isContextCompactArmed: (taskId: string) => boolean;
  armContextCompact: (taskId: string) => void;
  markSelfCompactActivity: (taskId: string) => void;
  /** 守卫重排后唤醒宿主循环（否则定时器可能睡过头）。 */
  scheduleNextTick: () => void;
}

/**
 * 返回是否放行派发。false 时意图已被守卫重排（不烧 attempt），宿主只等待下一次到期。
 */
export function createQuotaResumeGate(deps: QuotaResumeGateDeps) {
  async function admitClaimedIntent(
    intent: ResumeIntent,
    settings: QuotaWatchdogSettings,
    scope: CodingPlanResetScopeRequest | null,
  ): Promise<boolean> {
    const now = Date.now();
    if (intent.kind === "context") {
      if (!deps.isContextCompactArmed(intent.taskId)) {
        deps.armContextCompact(intent.taskId);
        deps.markSelfCompactActivity(intent.taskId);
        try {
          await deps.requestCompact({
            sessionId: intent.taskId,
            workspacePath: intent.workspacePath,
            workspaceIdentity: intent.workspaceIdentity,
          });
          serviceLogger.info("context compact requested before resume", {
            taskId: intent.taskId,
          });
        } catch (error) {
          serviceLogger.warn("context compact request failed, will retry", {
            taskId: intent.taskId,
            error: toErrorMessage(error),
          });
        }
        await deps.resumeIntentRepo.reschedulePending(
          intent.resumeIntentId,
          now + RESUME_CONTEXT_COMPACT_DELAY_MS,
          { now, kind: "context" },
        );
        deps.scheduleNextTick();
        return false;
      }
      return true;
    }

    let remaining: number | null = null;
    let nextResetTime: number | null = null;
    try {
      const fresh = await deps.usageStatsService.getEntitlementSnapshot();
      remaining = remainingPercentFromEntitlement(fresh.remaining?.percentage);
      nextResetTime = fresh.remaining?.nextResetTime ?? null;
    } catch (error) {
      serviceLogger.warn("dispatch gate snapshot failed", {
        taskId: intent.taskId,
        error: toErrorMessage(error),
      });
    }

    if (intent.kind === "transient" && remaining !== null && remaining <= 0) {
      await deps.resumeIntentRepo.reschedulePending(
        intent.resumeIntentId,
        quotaEligibleAt(nextResetTime ?? now + QUOTA_FALLBACK_RETRY_MS, now),
        { now, kind: "quota" },
      );
      serviceLogger.info("transient intent converted to quota, quota exhausted", {
        taskId: intent.taskId,
        remaining,
      });
      deps.scheduleNextTick();
      return false;
    }

    if (intent.kind !== "quota") {
      return true;
    }

    if (remaining === null) {
      await deps.resumeIntentRepo.reschedulePending(
        intent.resumeIntentId,
        now + QUOTA_GATE_UNKNOWN_SNAPSHOT_RETRY_MS,
        { now },
      );
      serviceLogger.info("quota intent deferred, snapshot unavailable", {
        taskId: intent.taskId,
      });
      deps.scheduleNextTick();
      return false;
    }
    if (remaining > 0) {
      return true;
    }

    if (settings.autoClaimResetCardsEnabled && scope) {
      try {
        const resetSnapshot = await deps.usageStatsService.getCodingPlanResetStatus(scope);
        const target = claimTargetForFailure("quota", resetSnapshot, now);
        if (target) {
          const claimedCard = await deps.claimResetCard(resetSnapshot, scope);
          if (claimedCard) {
            serviceLogger.info("reset card consumed for auto-resume", {
              taskId: intent.taskId,
              resetType: target,
            });
            return true;
          }
          await deps.resumeIntentRepo.reschedulePending(
            intent.resumeIntentId,
            now + QUOTA_CLAIM_RETRY_MS,
            { now },
          );
          deps.scheduleNextTick();
          return false;
        }
      } catch (error) {
        serviceLogger.warn("dispatch gate reset claim failed", {
          taskId: intent.taskId,
          error: toErrorMessage(error),
        });
      }
    }
    await deps.resumeIntentRepo.reschedulePending(
      intent.resumeIntentId,
      quotaEligibleAt(nextResetTime ?? now + QUOTA_FALLBACK_RETRY_MS, now),
      { now },
    );
    serviceLogger.info("quota intent deferred, waiting reset or claimable card", {
      taskId: intent.taskId,
      remaining,
    });
    deps.scheduleNextTick();
    return false;
  }

  return { admitClaimedIntent };
}

export type QuotaResumeGate = ReturnType<typeof createQuotaResumeGate>;

export { SELF_COMPACT_ACTIVE_WINDOW_MS };
