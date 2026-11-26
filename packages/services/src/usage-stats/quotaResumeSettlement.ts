import { RESUME_CONTEXT_COMPACT_DELAY_MS, type ResumeIntentKind } from "@zcode/shared";
import {
  quotaProbeDelayMs,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_FAST_FAIL_WINDOW_MS,
  transientRetryDelayMs,
  type ResumeFailureClassification,
} from "./quotaWatchdogDomain.js";

// v3 结算纯逻辑（docs/quota-watchdog/spec.md §9.4）：派发 turn 失败后的裁决。
// 无 IO、无时钟读取；service 只负责把裁决落到意图行。

/** 派发 turn 至少运行该时长才视为"有真实进展"（Transient 失败后连续计数清零）。 */
export const RESUME_PROGRESS_WINDOW_MS = 2 * 60_000;
/** 上下文溢出时自发 /compact 的最多次数（每次续跑后仍溢出计一次），用尽即 exhausted。 */
export const RESUME_MAX_CONTEXT_COMPACTS = 2;
/** compact 请求连续被拒的上限；超过后放行续跑，由结局裁决（仍溢出则 exhausted）。 */
export const RESUME_MAX_COMPACT_REJECTS = 2;

export type ResumeAttemptDelta = "increment" | "keep" | "reset";

export type ResumeSettleAction =
  | { type: "exhausted"; lastError: string }
  | {
      type: "requeue";
      kind: ResumeIntentKind;
      nextEligibleAt: number;
      attemptMode: ResumeAttemptDelta;
      /** 额度类且属快速失败（额度并未恢复）：不消耗 attempt，按探测阶梯退避。 */
      quotaFastFail: boolean;
    };

/** 首次建意图 / 类别改写时的到期延迟：一律很短，真正的等待（等重置 / 核销 / 压缩）由派发门裁决。 */
export function resumeInitialDelayMs(kind: ResumeIntentKind, attempt: number): number {
  if (kind === "quota") return RESUME_AFTER_CLAIM_DELAY_MS;
  if (kind === "context") return RESUME_CONTEXT_COMPACT_DELAY_MS;
  return transientRetryDelayMs(attempt);
}

/**
 * 看门狗派发的 turn 失败后的结算裁决（纯函数）。
 * - plan_expired / non_recoverable：终态 exhausted（自动重试无意义）。
 * - quota：20s 内失败 = 额度未恢复 → 不计 attempt，按 1→5→15→30min 探测阶梯；探测次数触顶即 exhausted。
 *   运行了一段时间才耗尽 = 新的耗尽周期 → 连续计数清零。
 * - transient：1→5→15min 退避并计 attempt，触顶 exhausted；运行 ≥2min 才失败视为有进展，计数清零。
 * - context：再给一次自发 compact 的机会（至多 RESUME_MAX_CONTEXT_COMPACTS 次），仍溢出即 exhausted。
 * - 无法归因：保持原类别、计 attempt（不适用进展清零：不知道失败是什么，不能假定它在推进）。
 */
export function planDispatchedFailureSettle(input: {
  classification: ResumeFailureClassification | null;
  intentKind: ResumeIntentKind;
  attempt: number;
  elapsedMs: number;
  fastFails: number;
  compactAttempts: number;
  maxConsecutive: number;
  message: string;
  now: number;
}): {
  action: ResumeSettleAction;
  fastFails: number;
  compactAttempts: number;
  disarmCompact: boolean;
} {
  const base = {
    fastFails: input.fastFails,
    compactAttempts: input.compactAttempts,
    disarmCompact: false,
  };
  const exhausted = (suffix: string): ResumeSettleAction => ({
    type: "exhausted",
    lastError: `${input.message} (${suffix}; auto-resume stopped)`,
  });
  switch (input.classification) {
    case "plan_expired":
    case "non_recoverable": {
      return { ...base, action: exhausted(input.classification) };
    }
    case "quota": {
      if (input.elapsedMs < RESUME_FAST_FAIL_WINDOW_MS) {
        const fastFails = input.fastFails + 1;
        if (fastFails >= input.maxConsecutive) {
          return { ...base, fastFails, action: exhausted("quota did not recover") };
        }
        return {
          ...base,
          fastFails,
          action: {
            type: "requeue",
            kind: "quota",
            nextEligibleAt: input.now + quotaProbeDelayMs(fastFails),
            attemptMode: "keep",
            quotaFastFail: true,
          },
        };
      }
      return {
        ...base,
        fastFails: 0,
        action: {
          type: "requeue",
          kind: "quota",
          nextEligibleAt: input.now + RESUME_AFTER_CLAIM_DELAY_MS,
          attemptMode: "reset",
          quotaFastFail: false,
        },
      };
    }
    case "transient": {
      const progressed = input.elapsedMs >= RESUME_PROGRESS_WINDOW_MS;
      const nextAttempt = progressed ? 0 : input.attempt + 1;
      if (nextAttempt >= input.maxConsecutive) {
        return { ...base, action: exhausted("max consecutive auto-resumes") };
      }
      return {
        ...base,
        action: {
          type: "requeue",
          kind: "transient",
          nextEligibleAt: input.now + transientRetryDelayMs(nextAttempt),
          attemptMode: progressed ? "reset" : "increment",
          quotaFastFail: false,
        },
      };
    }
    case "context": {
      // 每次续跑前派发门都已压缩过一次：第 N 次续跑仍溢出 = 第 N 次压缩没救回来。
      const compactAttempts = input.compactAttempts + 1;
      if (compactAttempts >= RESUME_MAX_CONTEXT_COMPACTS) {
        return {
          ...base,
          compactAttempts,
          disarmCompact: true,
          action: exhausted("context overflow persists after auto-compact"),
        };
      }
      return {
        ...base,
        fastFails: 0,
        compactAttempts,
        disarmCompact: true,
        action: {
          type: "requeue",
          kind: "context",
          nextEligibleAt: input.now + RESUME_CONTEXT_COMPACT_DELAY_MS,
          attemptMode: "keep",
          quotaFastFail: false,
        },
      };
    }
    default: {
      const nextAttempt = input.attempt + 1;
      if (nextAttempt >= input.maxConsecutive) {
        return { ...base, action: exhausted("unclassified failure repeated") };
      }
      return {
        ...base,
        action: {
          type: "requeue",
          kind: input.intentKind,
          nextEligibleAt: input.now + transientRetryDelayMs(nextAttempt),
          attemptMode: "increment",
          quotaFastFail: false,
        },
      };
    }
  }
}
