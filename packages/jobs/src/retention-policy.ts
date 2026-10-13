import type { RiskClass } from '@genai/contracts';
import type { CompiledCapability, SettingsRegistry } from '@genai/definitions';
import { retentionClasses, retentionPolicy, type RetentionPolicy } from '@genai/kernel';

export const retentionClassSetting = 'retention.class';
export const auditDaysSetting = 'retention.auditDays';
export const defaultAuditDays = 730;

export const retentionFor = (
  settings: SettingsRegistry,
  tenant: string,
  compiled: CompiledCapability | undefined,
): RetentionPolicy => {
  const descriptor = compiled?.capability.descriptor;
  const config = compiled?.capability.config as { settings?: Record<string, unknown> } | undefined;
  const effective = settings.effective(
    tenant,
    compiled
      ? {
          tenant,
          service: descriptor?.id ?? '',
          version: Number(descriptor?.version) || 1,
          settings: config?.settings ?? {},
        }
      : undefined,
  );
  const chosen = effective[retentionClassSetting]?.value;
  const audit = effective[auditDaysSetting]?.value;
  const riskClass: RiskClass = descriptor?.oversight.riskClass ?? 'high';
  return retentionPolicy({
    retentionClass: retentionClasses.find((c) => c === chosen) ?? 'standard',
    riskClass,
    auditDays: typeof audit === 'number' && audit > 0 ? audit : defaultAuditDays,
  });
};
