import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

// 配额守护与自动续跑设置（docs/quota-watchdog/spec.md §3.5）。
// 全部 opt-out：默认开启/默认值；四项全关 = 与现状零行为差异。
// 看门狗驻留桌面 Host 进程，App 不运行即不守护（行描述明确说明该限制）。

const QUOTA_WATCH_THRESHOLD_OPTIONS = [5, 10, 15, 20, 25, 30, 50] as const;
const AUTO_RESUME_MAX_CONSECUTIVE_OPTIONS = [3, 5, 8, 10, 15, 20] as const;

function withCurrentOption(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

export function AutoResumeSettingsCard({
  autoResumeEnabled,
  autoClaimResetCardsEnabled,
  quotaWatchThresholdPercent,
  autoResumeMaxConsecutive,
  onAutoResumeEnabledChange,
  onAutoClaimResetCardsEnabledChange,
  onQuotaWatchThresholdPercentChange,
  onAutoResumeMaxConsecutiveChange,
}: {
  autoResumeEnabled: boolean;
  autoClaimResetCardsEnabled: boolean;
  quotaWatchThresholdPercent: number;
  autoResumeMaxConsecutive: number;
  onAutoResumeEnabledChange: (enabled: boolean) => void;
  onAutoClaimResetCardsEnabledChange: (enabled: boolean) => void;
  onQuotaWatchThresholdPercentChange: (percent: number) => void;
  onAutoResumeMaxConsecutiveChange: (max: number) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.autoResume.autoResumeEnabled" })}
        description={intl.formatMessage({
          id: "settings.autoResume.autoResumeEnabledDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.autoResume.autoResumeEnabled" })}
            checked={autoResumeEnabled}
            onCheckedChange={onAutoResumeEnabledChange}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.autoResume.autoClaimResetCardsEnabled" })}
        description={intl.formatMessage({
          id: "settings.autoResume.autoClaimResetCardsEnabledDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.autoResume.autoClaimResetCardsEnabled",
            })}
            checked={autoClaimResetCardsEnabled}
            onCheckedChange={onAutoClaimResetCardsEnabledChange}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.autoResume.quotaWatchThresholdPercent" })}
        description={intl.formatMessage({
          id: "settings.autoResume.quotaWatchThresholdPercentDescription",
        })}
        control={
          <Select
            value={String(quotaWatchThresholdPercent)}
            onValueChange={(value) => {
              onQuotaWatchThresholdPercentChange(Number(value));
            }}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({
                id: "settings.autoResume.quotaWatchThresholdPercent",
              })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {withCurrentOption(QUOTA_WATCH_THRESHOLD_OPTIONS, quotaWatchThresholdPercent).map(
                (percent) => (
                  <SelectItem key={percent} value={String(percent)}>
                    {intl.formatMessage({ id: "settings.autoResume.percentValue" }, { percent })}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.autoResume.autoResumeMaxConsecutive" })}
        description={intl.formatMessage({
          id: "settings.autoResume.autoResumeMaxConsecutiveDescription",
        })}
        control={
          <Select
            value={String(autoResumeMaxConsecutive)}
            onValueChange={(value) => {
              onAutoResumeMaxConsecutiveChange(Number(value));
            }}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({
                id: "settings.autoResume.autoResumeMaxConsecutive",
              })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {withCurrentOption(
                AUTO_RESUME_MAX_CONSECUTIVE_OPTIONS,
                autoResumeMaxConsecutive,
              ).map((max) => (
                <SelectItem key={max} value={String(max)}>
                  {max}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}
