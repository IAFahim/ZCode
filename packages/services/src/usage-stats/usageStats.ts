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

/** 自动续跑失败上报参数（renderer 观测到 task_error 后调用；Host 侧是意图唯一所有者）。 */
export interface AutoResumeFailureReport {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  kind: "quota" | "transient";
  errorMessage: string;
  /** 上报时已知的套餐下次重置时刻（Unix 毫秒）；未知传 null，Host 侧退避兜底。 */
  nextResetTime: number | null;
  /** 失败 assistant 行目标（retryTurn 重放用）；无法定位时为 null，Host 走 sendText 回退。 */
  failedRowTarget?: { rowId: number; entityId: string } | null;
  /**
   * v2 修订：provider 业务码 / CLI 归因原因透传，Host 侧以此做权威归因
   * （1309 到期禁烧卡、1261 溢出走 /compact、1305 限流短退避），覆盖上报方的 kind 粗分类。
   */
  providerErrorCode?: string | null;
  attributionReason?: string | null;
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
