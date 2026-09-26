import { Hairline, Icon, Pressable, Text } from './primitives.tsx';
import { t } from '@auqw/ui-shared';
import type {
  SettingsModel,
  SettingsRowModel,
  SyncPanelModel,
} from '@auqw/ui-shared';

export type SettingsScreenProps = {
  readonly model: SettingsModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onSelectRow?: ((key: string) => void) | undefined;
  readonly onToggleRow?: ((key: string) => void) | undefined;
  readonly onOpenCorrections?: (() => void) | undefined;
  /** LAN sync panel — omitted entirely when the host has no sync seam. */
  readonly sync?: SyncPanelModel | undefined;
  readonly onPairDevice?: (() => void) | undefined;
  readonly onUnpairDevice?: ((deviceId: string) => void) | undefined;
  readonly onSyncNow?: (() => void) | undefined;
  readonly onExportDelta?: (() => void) | undefined;
  readonly onImportDelta?: (() => void) | undefined;
};

// Visual-only track+thumb — the row itself is the `switch` element;
// a nested control inside it duplicates (and on AT hides) the control.
function Toggle({ enabled }: { readonly enabled: boolean }) {
  return (
    <span
      className={`uw-toggle${enabled ? ' uw-toggle--on' : ''}`}
      aria-hidden="true"
    >
      <span className="uw-toggle__thumb" />
    </span>
  );
}

function SettingsRow({
  row,
  onSelectRow,
  onToggleRow,
}: {
  readonly row: SettingsRowModel;
  readonly onSelectRow?: ((key: string) => void) | undefined;
  readonly onToggleRow?: ((key: string) => void) | undefined;
}) {
  const interactive =
    row.kind === 'toggle' ? onToggleRow !== undefined : onSelectRow !== undefined;
  // `enabled` is the toggle's checked state (kind 'toggle') and the
  // disabled flag on every other kind — an off navigation/value row
  // renders visibly inert, never a live control that dead-presses.
  const off =
    !interactive || (row.kind !== 'toggle' && !row.enabled);
  const label = `${row.label}${row.value === null ? '' : `, ${row.value}`}`;
  const body = (
    <>
      <Text variant="body" color="primary" className="uw-settings-row__label">
        {row.label}
      </Text>
      {row.kind === 'toggle' ? (
        <Toggle enabled={row.enabled} />
      ) : (
        <>
          {row.value !== null && (
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {row.value}
            </Text>
          )}
          {row.kind === 'navigation' && (
            <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
          )}
        </>
      )}
    </>
  );
  if (row.kind === 'toggle') {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={row.enabled}
        aria-label={label}
        className={`uw-settings-row${off ? ' uw-off' : ''}`}
        disabled={off}
        onClick={
          interactive ? () => onToggleRow?.(row.key) : undefined
        }
      >
        {body}
      </button>
    );
  }
  return (
    <Pressable
      onPress={
        interactive ? () => onSelectRow?.(row.key) : undefined
      }
      disabled={off}
      ariaLabel={label}
      className="uw-settings-row"
    >
      {body}
    </Pressable>
  );
}

export function SettingsScreen({
  model,
  scrollEnabled = true,
  onSelectRow,
  onToggleRow,
  onOpenCorrections,
  sync,
  onPairDevice,
  onUnpairDevice,
  onSyncNow,
  onExportDelta,
  onImportDelta,
}: SettingsScreenProps) {
  const diagnostics = model.diagnostics;
  const persistenceColor =
    diagnostics.persistence === 'ok' ? 'secondary' : 'warn';
  return (
    <div
      className="uw-screen uw-settings"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <Text
        variant="label"
        color="secondary"
        uppercase
        className="uw-section-label"
      >
        {t('settings.heading.settings')}
      </Text>
      <div className="uw-card">
        {model.rows.map((row, i) => (
          <div key={row.key}>
            {i > 0 && <Hairline />}
            <SettingsRow
              row={row}
              onSelectRow={onSelectRow}
              onToggleRow={onToggleRow}
            />
          </div>
        ))}
      </div>
      <Text
        variant="label"
        color="secondary"
        uppercase
        className="uw-section-label uw-section-label--block"
      >
        {t('settings.heading.diagnostics')}
      </Text>
      <div className="uw-card uw-card--padded">
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            {t('settings.diag.providers')}
          </Text>
          <Text variant="metadata" color="primary">
            {diagnostics.providerIds.length === 0
              ? t('settings.diag.none')
              : diagnostics.providerIds.join(', ')}
          </Text>
        </div>
        <Hairline />
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            {t('settings.diag.attemptTrace')}
          </Text>
          <Text variant="metadata" color="primary" numeric>
            {t('settings.diag.attempts', { count: diagnostics.attemptCount })}
            {diagnostics.lastAttemptLabel === null
              ? ''
              : ` · ${t('settings.diag.last', { value: diagnostics.lastAttemptLabel })}`}
          </Text>
        </div>
        <Hairline />
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            {t('settings.diag.persistence')}
          </Text>
          <Text variant="metadata" color={persistenceColor}>
            {t(`settings.diag.persistenceValue.${diagnostics.persistence}`)}
            {diagnostics.persistenceDetail === null
              ? ''
              : ` · ${diagnostics.persistenceDetail}`}
          </Text>
        </div>
        <Hairline />
        {/*
         * The corrections queue entry — management-oriented: a count
         * when the caller has loaded reviews, the chevron always. Row
         * is inert without the callback (gallery).
         */}
        <Pressable
          onPress={onOpenCorrections}
          disabled={onOpenCorrections === undefined}
          ariaLabel={t('settings.diag.matchReviews')}
          className="uw-diag-row uw-diag-row--action"
        >
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            {t('settings.diag.matchReviews')}
          </Text>
          {diagnostics.pendingReviews !== null && (
            <Text variant="metadata" color="primary" numeric>
              {t('settings.diag.pending', { count: diagnostics.pendingReviews })}
            </Text>
          )}
          <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
        </Pressable>
      </div>
      {sync !== undefined && (
        <>
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label uw-section-label--block"
          >
            {t('settings.heading.sync')}
          </Text>
          <div className="uw-card uw-card--padded">
            {sync.status === null ? (
              <div className="uw-diag-row" data-state="placeholder">
                <Text
                  variant="metadata"
                  color="secondary"
                  className="uw-diag-row__k"
                >
                  <Icon
                    name="monitor"
                    size={12}
                    color="var(--text-secondary)"
                  />{' '}
                  {t('sync.panel.listener')}
                </Text>
                <Text variant="metadata" color="secondary">
                  {t('common.unavailable')}
                </Text>
              </div>
            ) : (
              <>
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    <Icon
                      name="monitor"
                      size={12}
                      color="var(--text-secondary)"
                    />{' '}
                    {t('sync.panel.listener')}
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.listenerLabel}
                    {t('sync.engineSuffix', { label: sync.status.engineLabel })}
                  </Text>
                </div>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    {t('sync.panel.thisDevice')}
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.nameLabel}
                    {sync.status.addressLabel === null
                      ? ''
                      : ` · ${sync.status.addressLabel}`}
                  </Text>
                </div>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    {t('sync.panel.advertise')}
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.advertiseLabel}
                    {t('sync.sessionsSuffix', { label: sync.status.sessionsLabel })}
                  </Text>
                </div>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    {t('sync.panel.lastSync')}
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.lastSyncLabel}
                  </Text>
                </div>
                {sync.status.fingerprintLabel !== null && (
                  <>
                    <Hairline />
                    <div className="uw-diag-row">
                      <Text
                        variant="metadata"
                        color="secondary"
                        className="uw-diag-row__k"
                      >
                        {t('sync.panel.fingerprint')}
                      </Text>
                      <Text variant="metadata" color="primary" numeric>
                        {sync.status.fingerprintLabel}
                      </Text>
                    </div>
                  </>
                )}
                <Hairline />
              </>
            )}
            <Pressable
              onPress={onPairDevice}
              disabled={onPairDevice === undefined}
              ariaLabel={t('sync.pairDevice')}
              className="uw-diag-row uw-diag-row--action"
            >
              <Text
                variant="metadata"
                color="secondary"
                className="uw-diag-row__k"
              >
                {t('sync.pairDevice')}
              </Text>
              <Icon
                name="chevron-right"
                size={12}
                color="var(--text-secondary)"
              />
            </Pressable>
            {sync.pairErrorLabel !== null && (
              <div className="uw-diag-row">
                <Text
                  variant="metadata"
                  color="warn"
                  className="uw-diag-row__k"
                >
                  {sync.pairErrorLabel}
                </Text>
              </div>
            )}
            <Hairline />
            <Pressable
              onPress={onSyncNow}
              disabled={onSyncNow === undefined}
              ariaLabel={t('sync.syncNow')}
              className="uw-diag-row uw-diag-row--action"
            >
              <Text
                variant="metadata"
                color="secondary"
                className="uw-diag-row__k"
              >
                {t('sync.syncNow')}
              </Text>
              <Icon
                name="chevron-right"
                size={12}
                color="var(--text-secondary)"
              />
            </Pressable>
            <Hairline />
            <div className="uw-diag-row">
              <Text
                variant="metadata"
                color="secondary"
                className="uw-diag-row__k"
              >
                {t('sync.panel.pairedDevices')}
              </Text>
              <Text variant="metadata" color="primary">
                {sync.devices.length === 0
                  ? t('settings.diag.none')
                  : `${sync.devices.length}`}
              </Text>
            </div>
            {sync.devices.map((device) => (
              <div key={device.id}>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    {device.name}
                  </Text>
                  <Text variant="metadata" color="primary" numberOfLines={1}>
                    {device.pairedLabel} · {device.lastSeenLabel}
                  </Text>
                  <Pressable
                    onPress={
                      onUnpairDevice === undefined
                        ? undefined
                        : () => onUnpairDevice(device.id)
                    }
                    disabled={onUnpairDevice === undefined}
                    ariaLabel={t('sync.unpairA11y', { name: device.name })}
                    className="uw-diag-row--action"
                  >
                    <Text variant="metadata" color="warn">
                      {t('sync.unpair')}
                    </Text>
                  </Pressable>
                </div>
              </div>
            ))}
            {(onExportDelta !== undefined ||
              onImportDelta !== undefined) && (
              <>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    {t('sync.panel.deltaExchange')}
                  </Text>
                  {onExportDelta !== undefined && (
                    <Pressable
                      onPress={onExportDelta}
                      ariaLabel={t('sync.panel.copyDelta')}
                      className="uw-diag-row--action"
                    >
                      <Text variant="metadata" color="primary">
                        {t('sync.panel.copyDelta')}
                      </Text>
                    </Pressable>
                  )}
                  {onImportDelta !== undefined && (
                    <Pressable
                      onPress={onImportDelta}
                      ariaLabel={t('sync.panel.pasteDelta')}
                      className="uw-diag-row--action"
                    >
                      <Text variant="metadata" color="primary">
                        {t('sync.panel.pasteDelta')}
                      </Text>
                    </Pressable>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
