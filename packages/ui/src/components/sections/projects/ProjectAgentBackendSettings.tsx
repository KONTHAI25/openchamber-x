import * as React from 'react';

import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createRuntimeAgentClient, type AgentClient } from '@/lib/agents/client';
import type { AgentBackend, AgentBackendStatus } from '@/lib/agents/contracts';
import { agentBackendPreferenceStore, getAgentBackendPreference, setAgentBackendPreference } from '@/lib/agents/preferences';
import { useI18n } from '@/lib/i18n';
import { ProjectSettingsSubsection } from './ProjectSettingsSubsection';

interface ProjectAgentBackendSettingsProps {
  directory: string;
  agentClient?: AgentClient;
}

export const ProjectAgentBackendSettings: React.FC<ProjectAgentBackendSettingsProps> = ({
  directory,
  agentClient: providedAgentClient,
}) => {
  const { t } = useI18n();
  const agentClient = React.useMemo(
    () => providedAgentClient ?? createRuntimeAgentClient(),
    [providedAgentClient],
  );
  const [backend, setBackend] = React.useState<AgentBackend>(() => getAgentBackendPreference(directory));
  const [codexStatus, setCodexStatus] = React.useState<AgentBackendStatus | null>(null);
  const [isCheckingCodex, setIsCheckingCodex] = React.useState(true);

  React.useEffect(() => {
    return agentBackendPreferenceStore.subscribe((changedDirectory) => {
      if (changedDirectory === directory) setBackend(getAgentBackendPreference(directory));
    });
  }, [directory]);

  React.useEffect(() => {
    let cancelled = false;
    const savedBackend = getAgentBackendPreference(directory);
    setBackend(savedBackend);
    setCodexStatus(null);
    setIsCheckingCodex(true);

    void agentClient.getStatus('codex').then((result) => {
      if (cancelled) {
        return;
      }
      const nextStatus = result.ok ? result.data : null;
      setCodexStatus(nextStatus);
      setIsCheckingCodex(false);
    }).catch(() => {
      if (!cancelled) {
        setCodexStatus(null);
        setIsCheckingCodex(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agentClient, directory]);

  const codexAvailable = codexStatus?.status === 'available';

  const handleBackendChange = React.useCallback((nextBackend: AgentBackend) => {
    if (nextBackend === 'codex' && !codexAvailable) {
      return;
    }
    setAgentBackendPreference(directory, nextBackend);
    setBackend(nextBackend);
  }, [codexAvailable, directory]);

  const codexLabel = isCheckingCodex
    ? t('settings.projects.page.agentBackend.state.checkingCodex')
    : codexAvailable
      ? t('settings.projects.page.agentBackend.option.codex')
      : t('settings.projects.page.agentBackend.option.codexUnavailable');

  return (
    <ProjectSettingsSubsection
      title={t('settings.projects.page.agentBackend.title')}
      info={t('settings.projects.page.agentBackend.description')}
      settingsItem="projects.agent-backend"
    >
      <SettingsFieldRow
        label={t('settings.projects.page.agentBackend.field.backend')}
        description={!isCheckingCodex && !codexAvailable ? t('settings.projects.page.agentBackend.state.codexUnavailable') : undefined}
      >
        <Select<AgentBackend> value={backend} onValueChange={handleBackendChange}>
          <SelectTrigger
            size={SETTINGS_SELECT_SIZE}
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
            aria-label={t('settings.projects.page.agentBackend.field.backend')}
          >
            <SelectValue>
              {(value) => value === 'codex' ? codexLabel : t('settings.projects.page.agentBackend.option.opencode')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opencode">
              {t('settings.projects.page.agentBackend.option.opencode')}
            </SelectItem>
            <SelectItem value="codex" disabled={!codexAvailable}>
              {codexLabel}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
    </ProjectSettingsSubsection>
  );
};
