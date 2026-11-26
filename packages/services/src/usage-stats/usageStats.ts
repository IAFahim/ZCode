import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  QuotaWatchdogStatus,
  ResumeIntent,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 自动续跑失败上报参数（renderer 观察到 task_error 后调用；Host 侧是意图唯一所有者）。
 * v3：renderer 只上报失败事实，归因 / 卡型 / 调度全部在 Host。宿主另有全量 detector
 * （task index 同步器），本上报只是可见会话的冗余通道，Host 按签名与时间窗去重。
 */
export interface AutoResumeFailureReport {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 失败发生时刻（SessionErrorInfo.at，Unix 毫秒）。必带：Host 丢弃重新挂载后的陈旧重放。 */
  errorAt: number;
  errorMessage: string;
  /** CLI 归类码（SessionErrorInfo.code）。 */
  code?: string | null;
  /** provider 业务码 / CLI 归因原因 / 失败来源——Host 侧权威归类的输入。 */
  providerErrorCode?: string | null;
  attributionReason?: string | null;
  source?: string | null;
}

/** 配额守护委托面（quotaWatchdogService 结构化实现；Host 侧组装时注入）。 */
export interface IUsageStatsAutoResumeDelegate {
  reportAutoResumeFailure(params: AutoResumeFailureReport): Promise<void>;
  cancelAutoResume(params: { taskId: string; reason: string }): Promise<void>;
  getAutoResumeIntent(taskId: string): Promise<ResumeIntent | null>;
  getQuotaWatchdogStatus(): Promise<QuotaWatchdogStatus | null>;
}

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanRegularTps?(request: CodingPlanRegularTpsRequest): Promise<number | undefined>;
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
  // 配额守护与自动续跑（docs/quota-watchdog/spec.md）；未装配看门狗的运行时为 undefined。
  reportAutoResumeFailure?(params: AutoResumeFailureReport): Promise<void>;
  cancelAutoResume?(params: { taskId: string; reason: string }): Promise<void>;
  getAutoResumeIntent?(taskId: string): Promise<ResumeIntent | null>;
  getQuotaWatchdogStatus?(): Promise<QuotaWatchdogStatus | null>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
