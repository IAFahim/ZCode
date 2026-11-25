import { useEffect, useRef } from "react";
import type { IUsageStatsService } from "@zcode/services";
import type { SessionErrorInfo } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanQuotaExhaustedBusinessCode,
} from "@/lib/providerBusinessError.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 自动续跑失败上报（docs/quota-watchdog/spec.md §3.3）：
// renderer 只上报"观察到的失败事实"，意图的接纳/去重/调度全部由 Host 侧看门狗所有。
// v1 归因口径从紧：仅额度耗尽与限流/网络类失败建意图，其余失败（鉴权、配置、工具等）
// 交给用户手动处理，避免自动重试无意义消耗额度。

/** 限流/瞬时类业务码（轮内重试预算耗尽后仍失败才会上报到这里）。 */
const TRANSIENT_RATE_LIMIT_CODES = new Set(["429", "3002", "2007", "1302", "1303", "1305"]);

/** 额度耗尽类业务码（provider error code 与会话 code 同口径，见 failure-provider-business-codes.ts）。 */
const QUOTA_PROVIDER_ERROR_CODES = new Set(["1005", "1304", "1308", "1310", "1313"]);

export type AutoResumeFailureKind = "quota" | "transient";

export function classifyAutoResumeFailure(params: {
  error: Pick<SessionErrorInfo, "code" | "message" | "source" | "attribution">;
  providerId: string | null;
}): AutoResumeFailureKind | null {
  const { error } = params;
  // attribution.reason 是 CLI 侧可信业务根因（chatErrorAttribution 同款口径）。
  if (error.attribution?.reason === "quota_exhausted") {
    return "quota";
  }
  const providerErrorCode = error.attribution?.providerErrorCode?.trim();
  if (
    (providerErrorCode && QUOTA_PROVIDER_ERROR_CODES.has(providerErrorCode)) ||
    (error.code && QUOTA_PROVIDER_ERROR_CODES.has(error.code))
  ) {
    return "quota";
  }
  if (resolveStartPlanQuotaExhaustedBusinessCode(error.code, error.message) === "1005") {
    return "quota";
  }
  if (resolveGlmQuotaBannerBusinessCode(error.code) !== null) {
    return "quota";
  }
  if ((error.code && TRANSIENT_RATE_LIMIT_CODES.has(error.code)) || error.source === "network") {
    return "transient";
  }
  // legacy wrapper：消息文本兜底（providerBusinessError 同款匹配口径）。
  const message = error.message.toLowerCase();
  if (
    message.includes("exceed limit") ||
    message.includes("exceed quota limit") ||
    message.includes("quota exceeded")
  ) {
    return "quota";
  }
  return null;
}

/**
 * 任务失败时向 Host 看门狗上报自动续跑事实（幂等：同一 errorKey 只上报一次）。
 * Host 关闭/离线时调用失败仅记录 warn，不影响原有错误展示。
 */
export function useAutoResumeReport(params: {
  sessionId: string | null;
  workspacePath: string | null;
  workspaceIdentity?: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  providerId: string | null;
  usageStatsService?: IUsageStatsService;
}): void {
  const { intl } = useZCodeIntl();
  const lastReportedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const { error, errorKey, sessionId, workspacePath, usageStatsService } = params;
    if (!error || !errorKey || !sessionId || !workspacePath) {
      return;
    }
    if (!usageStatsService?.reportAutoResumeFailure) {
      return;
    }
    if (lastReportedKeyRef.current === errorKey) {
      return;
    }
    lastReportedKeyRef.current = errorKey;
    const kind = classifyAutoResumeFailure({
      error,
      providerId: params.providerId,
    });
    if (!kind) {
      return;
    }
    // 失败事实进入 Host 后由看门狗去重与调度；这里只保证一次失败上报一次。
    // v2：透传 provider 业务码 / CLI 归因，Host 侧做权威归类（1309 禁烧卡、1261 先压缩、1305 短退避）。
    void usageStatsService
      .reportAutoResumeFailure({
        taskId: sessionId,
        workspacePath,
        ...(params.workspaceIdentity?.trim()
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
        kind,
        errorMessage: error.message,
        nextResetTime: null,
        failedRowTarget: null,
        providerErrorCode: error.attribution?.providerErrorCode?.trim() || error.code || null,
        attributionReason: error.attribution?.reason ?? null,
      })
      .then(() => {
        toast(
          intl.formatMessage({
            id: kind === "quota" ? "chat.autoResume.armedQuota" : "chat.autoResume.armedTransient",
          }),
          { variant: "info" },
        );
      })
      .catch((reportError: unknown) => {
        logger.warn("auto-resume failure report failed", {
          taskId: sessionId,
          error: reportError instanceof Error ? reportError.message : String(reportError),
        });
      });
  }, [
    intl,
    params.error,
    params.errorKey,
    params.providerId,
    params.sessionId,
    params.usageStatsService,
    params.workspaceIdentity,
    params.workspacePath,
  ]);
}
