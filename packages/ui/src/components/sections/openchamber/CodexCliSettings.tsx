import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { createRuntimeAgentClient, type AgentClient } from '@/lib/agents/client';
import type { AgentAccount, AgentBackendStatus, JsonObject, JsonValue } from '@/lib/agents/contracts';
import { getRuntimeKey } from '@/lib/runtime-switch';

export interface CodexAuthSnapshot {
  status: AgentBackendStatus;
  account: AgentAccount;
}

export interface CodexDeviceLogin {
  verificationUrl: string;
  userCode: string;
  waitForCompletion: () => Promise<CodexAuthSnapshot>;
}

export interface CodexAuthClient {
  startDeviceLogin: () => Promise<CodexDeviceLogin>;
  cancelDeviceLogin: () => Promise<void>;
  logout: () => Promise<void>;
}

export interface CodexCliSettingsProps {
  agentClient?: AgentClient;
  authClient?: CodexAuthClient | null;
}

const TAG_STRING = '[object String]';

const isStringValue = (value: JsonValue | undefined): value is string => {
  return value !== undefined && Object.prototype.toString.call(value) === TAG_STRING;
};

/** Parse the raw device-login response at the I/O boundary into required string fields. */
const parseDeviceLoginData = (
  value: JsonValue,
): { ok: true; verificationUrl: string; userCode: string; loginId: string } | { ok: false } => {
  if (value === null || Array.isArray(value) || Object.prototype.toString.call(value) !== '[object Object]') {
    return { ok: false };
  }
  // SAFETY: the tag check above establishes `value` is a plain object (a JSON object).
  const record = value as JsonObject;
  const verificationUrl = isStringValue(record.verificationUrl) ? record.verificationUrl : undefined;
  const userCode = isStringValue(record.userCode) ? record.userCode : undefined;
  const loginId = isStringValue(record.loginId) ? record.loginId : undefined;
  if (!verificationUrl || !userCode || !loginId) return { ok: false };
  return { ok: true, verificationUrl, userCode, loginId };
};

const createCodexAuthClient = (agentClient: AgentClient): CodexAuthClient => {
  let loginId: string | null = null;
  let loginGeneration = 0;
  const config = () => ({ backend: 'codex' as const, directory: '', runtimeKey: getRuntimeKey() });
  return {
    startDeviceLogin: async () => {
      const generation = loginGeneration + 1;
      loginGeneration = generation;
      const result = await agentClient.startDeviceLogin({
        ...config(),
        input: { type: 'chatgptDeviceCode' },
      });
      if (!result.ok || !result.data) throw new Error('Codex device login could not be started');
      const parsed = parseDeviceLoginData(result.data);
      if (!parsed.ok) throw new Error('Codex returned an invalid device login response');
      loginId = parsed.loginId;
      return {
        verificationUrl: parsed.verificationUrl,
        userCode: parsed.userCode,
        waitForCompletion: async () => {
          for (let attempt = 0; attempt < 300; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            if (generation !== loginGeneration) throw new Error('Codex device login was cancelled');
            const [status, account] = await Promise.all([
              agentClient.getStatus('codex'),
              agentClient.getAccount('codex'),
            ]);
            if (status.ok && account.ok && account.data?.authenticated) {
              loginId = null;
              return { status: status.data, account: account.data };
            }
          }
          throw new Error('Codex device login timed out');
        },
      };
    },
    cancelDeviceLogin: async () => {
      loginGeneration += 1;
      if (!loginId) return;
      const result = await agentClient.cancelDeviceLogin({ ...config(), input: { loginId } });
      if (!result.ok) throw new Error(result.error.message);
      loginId = null;
    },
    logout: async () => {
      loginGeneration += 1;
      const result = await agentClient.logout(config());
      if (!result.ok) throw new Error(result.error.message);
      loginId = null;
    },
  };
};

const statusValueClass = (status: 'success' | 'warning' | 'muted'): string => {
  if (status === 'success') {
    return 'text-[var(--status-success)]';
  }
  if (status === 'warning') {
    return 'text-[var(--status-warning)]';
  }
  return 'text-muted-foreground';
};

export const CodexCliSettings: React.FC<CodexCliSettingsProps> = ({
  agentClient: providedAgentClient,
  authClient: providedAuthClient,
}) => {
  const { t } = useI18n();
  const agentClient = React.useMemo(
    () => providedAgentClient ?? createRuntimeAgentClient(),
    [providedAgentClient],
  );
  const authClient = React.useMemo(
    () => providedAuthClient ?? createCodexAuthClient(agentClient),
    [agentClient, providedAuthClient],
  );
  const [status, setStatus] = React.useState<AgentBackendStatus | null>(null);
  const [account, setAccount] = React.useState<AgentAccount | null>(null);
  const [accountLoadFailed, setAccountLoadFailed] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [login, setLogin] = React.useState<CodexDeviceLogin | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);
  const [isCancellingLogin, setIsCancellingLogin] = React.useState(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const loginOperationRef = React.useRef(0);

  const refreshStatus = React.useCallback(async () => {
    setIsRefreshing(true);
    setErrorMessage(null);
    try {
      const [statusResult, accountResult] = await Promise.all([
        agentClient.getStatus('codex'),
        agentClient.getAccount('codex'),
      ]);
      if (!statusResult.ok) {
        throw new Error('Codex status request failed');
      }
      setStatus(statusResult.data);
      if (accountResult.ok) {
        setAccount(accountResult.data);
        setAccountLoadFailed(false);
      } else {
        setAccountLoadFailed(true);
      }
    } catch {
      setErrorMessage(t('settings.openchamber.codexCli.toast.refreshFailed'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [agentClient, t]);

  React.useEffect(() => {
    loginOperationRef.current += 1;
    setStatus(null);
    setAccount(null);
    setAccountLoadFailed(false);
    setLogin(null);
    setErrorMessage(null);
    setIsLoading(true);
    setIsLoggingIn(false);
    setIsCancellingLogin(false);
    void refreshStatus();
  }, [agentClient, refreshStatus]);

  const startLogin = React.useCallback(async () => {
    if (!authClient || isLoggingIn) {
      return;
    }

    setErrorMessage(null);
    setIsLoggingIn(true);
    const operation = loginOperationRef.current + 1;
    loginOperationRef.current = operation;
    try {
      const nextLogin = await authClient.startDeviceLogin();
      if (loginOperationRef.current !== operation) {
        return;
      }
      setLogin(nextLogin);

      void nextLogin.waitForCompletion().then((nextStatus) => {
        if (loginOperationRef.current !== operation) {
          return;
        }
        setStatus(nextStatus.status);
        setAccount(nextStatus.account);
        setAccountLoadFailed(false);
        setLogin(null);
        setIsLoggingIn(false);
      }).catch(() => {
        if (loginOperationRef.current !== operation) {
          return;
        }
        setLogin(null);
        setIsLoggingIn(false);
        setErrorMessage(t('settings.openchamber.codexCli.toast.loginFailed'));
      });
    } catch {
      if (loginOperationRef.current !== operation) {
        return;
      }
      setIsLoggingIn(false);
      setErrorMessage(t('settings.openchamber.codexCli.toast.loginFailed'));
    }
  }, [authClient, isLoggingIn, t]);

  const cancelLogin = React.useCallback(async () => {
    if (!authClient || !isLoggingIn || isCancellingLogin) {
      return;
    }

    const operation = loginOperationRef.current;
    setIsCancellingLogin(true);
    setErrorMessage(null);
    try {
      await authClient.cancelDeviceLogin();
      if (loginOperationRef.current === operation) {
        loginOperationRef.current += 1;
      }
      setLogin(null);
      setIsLoggingIn(false);
    } catch {
      setErrorMessage(t('settings.openchamber.codexCli.toast.cancelLoginFailed'));
    } finally {
      setIsCancellingLogin(false);
    }
  }, [authClient, isCancellingLogin, isLoggingIn, t]);

  const logout = React.useCallback(async () => {
    if (!authClient || isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setErrorMessage(null);
    try {
      await authClient.logout();
      await refreshStatus();
    } catch {
      setErrorMessage(t('settings.openchamber.codexCli.toast.logoutFailed'));
    } finally {
      setIsLoggingOut(false);
    }
  }, [authClient, isLoggingOut, refreshStatus, t]);

  const availabilityLabel = isLoading
    ? t('settings.openchamber.codexCli.state.loading')
    : status == null
      ? t('settings.openchamber.codexCli.state.unknown')
      : status.status === 'available'
        ? t('settings.openchamber.codexCli.state.available')
        : t('settings.openchamber.codexCli.state.unavailable');
  const availabilityStatus = status == null || status.status !== 'available'
    ? status == null ? 'muted' : 'warning'
    : 'success';
  const accountLabel = accountLoadFailed
    ? t('settings.openchamber.codexCli.state.unknown')
    : account?.authenticated
      ? account.name && account.email
        ? [account.name, account.email].join(' · ')
        : account.name ?? account.email ?? t('settings.openchamber.codexCli.state.notSignedIn')
      : t('settings.openchamber.codexCli.state.notSignedIn');
  const actionDisabled = isLoading || isRefreshing;

  return (
    <SettingsSection
      title={t('settings.openchamber.codexCli.title')}
      info={t('settings.openchamber.codexCli.description')}
      settingsItem="general.codex-cli"
      headerAction={(
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void refreshStatus()}
          disabled={actionDisabled}
          data-settings-item="general.codex-cli-refresh"
        >
          {isRefreshing ? t('settings.openchamber.codexCli.actions.refreshing') : t('settings.openchamber.codexCli.actions.refresh')}
        </Button>
      )}
    >
      <SettingsControlGroup
        title={t('settings.openchamber.codexCli.section.host')}
        settingsItem="general.codex-cli-host"
        contentClassName="space-y-2"
      >
        <SettingsFieldRow
          label={t('settings.openchamber.codexCli.field.availability')}
          settingsItem="general.codex-cli-availability"
        >
          <span className={statusValueClass(availabilityStatus)}>
            {availabilityLabel}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t('settings.openchamber.codexCli.field.version')}
          settingsItem="general.codex-cli-version"
        >
          <span className="typography-meta text-muted-foreground">
            {status?.version ?? t('settings.openchamber.codexCli.state.unknown')}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t('settings.openchamber.codexCli.field.account')}
          settingsItem="general.codex-cli-account"
        >
          <span className="typography-meta break-all text-muted-foreground">
            {accountLabel}
          </span>
        </SettingsFieldRow>
      </SettingsControlGroup>

      <SettingsControlGroup
        title={t('settings.openchamber.codexCli.section.account')}
        contentClassName="space-y-2"
      >
        {!authClient ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.codexCli.state.authUnavailable')}
          </p>
        ) : null}
        <SettingsFieldRow
          label={isLoggingIn ? t('settings.openchamber.codexCli.state.loginInProgress') : t('settings.openchamber.codexCli.field.login')}
          settingsItem="general.codex-cli-login"
        >
          {login ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void cancelLogin()}
              disabled={isCancellingLogin}
            >
              {isCancellingLogin ? t('settings.openchamber.codexCli.actions.cancellingLogin') : t('settings.openchamber.codexCli.actions.cancelLogin')}
            </Button>
          ) : (
            <Button
              type="button"
              size="xs"
              onClick={() => void startLogin()}
              disabled={actionDisabled || isLoggingIn || !authClient}
            >
              {t('settings.openchamber.codexCli.actions.login')}
            </Button>
          )}
        </SettingsFieldRow>

        {login ? (
          <>
            <p className="typography-meta text-muted-foreground">
              {t('settings.openchamber.codexCli.state.deviceCodeInstructions')}
            </p>
            <SettingsFieldRow label={t('settings.openchamber.codexCli.field.verificationUrl')}>
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-[24rem] break-all text-sm text-primary underline underline-offset-2"
                title={t('settings.openchamber.codexCli.actions.openVerificationUrl')}
              >
                {login.verificationUrl}
              </a>
            </SettingsFieldRow>
            <SettingsFieldRow label={t('settings.openchamber.codexCli.field.deviceCode')}>
              <code className="font-mono text-sm text-foreground">{login.userCode}</code>
            </SettingsFieldRow>
          </>
        ) : null}

        <SettingsFieldRow
          label={t('settings.openchamber.codexCli.field.logout')}
          settingsItem="general.codex-cli-logout"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void logout()}
            disabled={actionDisabled || account?.authenticated !== true || isLoggingOut || !authClient}
            className="!font-normal text-muted-foreground hover:text-foreground"
          >
            {isLoggingOut ? t('settings.openchamber.codexCli.actions.loggingOut') : t('settings.openchamber.codexCli.actions.logout')}
          </Button>
        </SettingsFieldRow>
      </SettingsControlGroup>

      {errorMessage ? (
        <p className="typography-meta text-[var(--status-error)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </SettingsSection>
  );
};
