import { Hairline, Icon, Pressable, Text } from './primitives.tsx';
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
  // `enabled` is the toggle's checked state (kind 'toggle') and a
  // badge on the others — disabled-ness is callback presence only,
  // same as ui-native.
  const off = !interactive;
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
        disabled={!interactive}
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
      disabled={!interactive}
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
        settings
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
        diagnostics
      </Text>
      <div className="uw-card uw-card--padded">
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            providers
          </Text>
          <Text variant="metadata" color="primary">
            {diagnostics.providerIds.length === 0
              ? 'none'
              : diagnostics.providerIds.join(', ')}
          </Text>
        </div>
        <Hairline />
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            attempt trace
          </Text>
          <Text variant="metadata" color="primary" numeric>
            {diagnostics.attemptCount} attempts
            {diagnostics.lastAttemptLabel === null
              ? ''
              : ` · last: ${diagnostics.lastAttemptLabel}`}
          </Text>
        </div>
        <Hairline />
        <div className="uw-diag-row">
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            persistence
          </Text>
          <Text variant="metadata" color={persistenceColor}>
            {diagnostics.persistence}
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
          ariaLabel="match reviews"
          className="uw-diag-row uw-diag-row--action"
        >
          <Text variant="metadata" color="secondary" className="uw-diag-row__k">
            match reviews
          </Text>
          {diagnostics.pendingReviews !== null && (
            <Text variant="metadata" color="primary" numeric>
              {diagnostics.pendingReviews} pending
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
            sync
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
                  listener
                </Text>
                <Text variant="metadata" color="secondary">
                  unavailable
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
                    listener
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.listenerLabel}
                    {` · engine ${sync.status.engineLabel}`}
                  </Text>
                </div>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    this device
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
                    advertise
                  </Text>
                  <Text variant="metadata" color="primary">
                    {sync.status.advertiseLabel}
                    {` · sessions ${sync.status.sessionsLabel}`}
                  </Text>
                </div>
                <Hairline />
                <div className="uw-diag-row">
                  <Text
                    variant="metadata"
                    color="secondary"
                    className="uw-diag-row__k"
                  >
                    last sync
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
                        fingerprint
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
              ariaLabel="pair a device"
              className="uw-diag-row uw-diag-row--action"
            >
              <Text
                variant="metadata"
                color="secondary"
                className="uw-diag-row__k"
              >
                pair a device
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
              ariaLabel="sync now"
              className="uw-diag-row uw-diag-row--action"
            >
              <Text
                variant="metadata"
                color="secondary"
                className="uw-diag-row__k"
              >
                sync now
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
                paired devices
              </Text>
              <Text variant="metadata" color="primary">
                {sync.devices.length === 0
                  ? 'none'
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
                    ariaLabel={`unpair ${device.name}`}
                    className="uw-diag-row--action"
                  >
                    <Text variant="metadata" color="warn">
                      unpair
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
                    delta exchange
                  </Text>
                  {onExportDelta !== undefined && (
                    <Pressable
                      onPress={onExportDelta}
                      ariaLabel="copy delta"
                      className="uw-diag-row--action"
                    >
                      <Text variant="metadata" color="primary">
                        copy delta
                      </Text>
                    </Pressable>
                  )}
                  {onImportDelta !== undefined && (
                    <Pressable
                      onPress={onImportDelta}
                      ariaLabel="paste delta"
                      className="uw-diag-row--action"
                    >
                      <Text variant="metadata" color="primary">
                        paste delta
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
