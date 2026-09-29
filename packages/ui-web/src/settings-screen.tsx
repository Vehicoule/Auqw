import { useEffect, useRef, useState } from 'react';
import { Hairline, Icon, Pressable, Text } from './primitives.tsx';
import { focusTargetAfterRemoval } from './settings-focus.ts';
import { settingsGroups, t } from '@auqw/ui-shared';
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
  /**
   * Bump to scroll the inline sync section into view and focus it —
   * the 'sync' settings row is a navigation row whose destination is
   * this section (there is no separate sync screen on desktop).
   */
  readonly syncFocusTick?: number | undefined;
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
  onConfirmed,
  registerRowEl,
}: {
  readonly row: SettingsRowModel;
  readonly onSelectRow?: ((key: string) => void) | undefined;
  readonly onToggleRow?: ((key: string) => void) | undefined;
  /**
   * The armed pair committed a destructive action — the screen marks
   * the key so it can hand focus to a neighbor if the row goes away.
   */
  readonly onConfirmed?: ((key: string) => void) | undefined;
  /** Registers the row's button element for focus recovery. */
  readonly registerRowEl?:
    | ((key: string, el: HTMLButtonElement | null) => void)
    | undefined;
}) {
  const [armed, setArmed] = useState(false);
  // Focus follows the slot: arming replaces the row's button with the
  // confirm pair — without the hand-off a keyboard press strands focus
  // on the removed control.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const wasArmed = useRef(false);
  useEffect(() => {
    if (armed) {
      wasArmed.current = true;
      confirmRef.current?.focus();
    } else if (wasArmed.current) {
      wasArmed.current = false;
      rowRef.current?.focus();
    }
  }, [armed]);
  const interactive =
    row.kind === 'toggle' ? onToggleRow !== undefined : onSelectRow !== undefined;
  // `enabled` is the toggle's checked state (kind 'toggle') and the
  // disabled flag on every other kind — an off navigation/value row
  // renders visibly inert, never a live control that dead-presses.
  const off =
    !interactive || (row.kind !== 'toggle' && !row.enabled);
  const label = `${row.label}${row.value === null ? '' : `, ${row.value}`}`;
  // Destructive rows confirm in place — the playlist delete's two-tap:
  // the first press arms, the armed slot splits into commit + cancel.
  const confirms = row.destructive === true && row.kind !== 'toggle';
  // Arm state must not outlive the row it was armed on — a re-rendered
  // (disabled, rekeyed) row silently drops any pending confirm.
  useEffect(() => {
    if (!confirms || !interactive || !row.enabled) {
      setArmed(false);
    }
  }, [confirms, interactive, row.enabled, row.key]);
  if (armed && interactive) {
    const confirmLabel = t('settings.confirmAction', { action: row.label });
    return (
      <div className="uw-settings-confirm" role="group" aria-label={label}>
        <Pressable
          ref={confirmRef}
          onPress={() => {
            setArmed(false);
            onConfirmed?.(row.key);
            onSelectRow?.(row.key);
          }}
          ariaLabel={confirmLabel}
          className="uw-headbtn uw-headbtn--warn"
        >
          <Text variant="metadata" color="warn">
            {confirmLabel}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setArmed(false)}
          ariaLabel={t('common.cancel')}
          className="uw-headbtn"
        >
          <Text variant="metadata" color="primary">
            {t('common.cancel')}
          </Text>
        </Pressable>
      </div>
    );
  }
  const body = (
    <>
      <Text
        variant="body"
        color={row.destructive === true ? 'warn' : 'primary'}
        className="uw-settings-row__label"
      >
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
      ref={(el) => {
        rowRef.current = el;
        registerRowEl?.(row.key, el);
      }}
      onPress={
        !interactive
          ? undefined
          : confirms
            ? () => setArmed(true)
            : () => onSelectRow?.(row.key)
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
  syncFocusTick = 0,
  onPairDevice,
  onUnpairDevice,
  onSyncNow,
  onExportDelta,
  onImportDelta,
}: SettingsScreenProps) {
  const diagnostics = model.diagnostics;
  const syncSectionRef = useRef<HTMLElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  // Confirmed destructive rows can vanish with their focused control —
  // remember which key committed, then hand focus to its nearest
  // still-focusable neighbor (or the screen when none survives).
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const rowOrderRef = useRef<readonly string[]>([]);
  const pendingFocus = useRef<{ key: string; before: readonly string[] } | null>(
    null,
  );
  const groups = settingsGroups(model.rows);
  const rowOrder = groups.flatMap((group) => group.rows.map((row) => row.key));
  useEffect(() => {
    const pending = pendingFocus.current;
    rowOrderRef.current = rowOrder;
    if (pending === null) {
      return;
    }
    const stillThere = model.rows.find(
      (row) => row.key === pending.key && row.enabled,
    );
    if (stillThere !== undefined) {
      // The action kept the row — stand down only once focus actually
      // landed back on it; an async removal can lag a render behind
      // the confirm press.
      const el = rowEls.current.get(pending.key);
      if (el !== undefined && el.contains(document.activeElement)) {
        pendingFocus.current = null;
      }
      return;
    }
    // Recover only when focus actually died with the row (fell back to
    // the document, or sits on the now-disabled element). A user who
    // moved to another control while the removal ran keeps their spot.
    const deadEl = rowEls.current.get(pending.key);
    const active = document.activeElement;
    const focusLost =
      active === null ||
      active === document.body ||
      active === document.documentElement ||
      (deadEl !== undefined && active === deadEl && deadEl.disabled);
    const focusable = new Set(
      model.rows.filter((row) => row.enabled).map((row) => row.key),
    );
    const target = focusTargetAfterRemoval(
      pending.before,
      focusable,
      pending.key,
    );
    pendingFocus.current = null;
    if (!focusLost) {
      return;
    }
    const el =
      (target === null ? undefined : rowEls.current.get(target)) ??
      screenRef.current;
    el?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (syncFocusTick === 0) {
      return;
    }
    const node = syncSectionRef.current;
    if (node === null) {
      return;
    }
    // Focus lands on the section itself (tabIndex -1, not the tab
    // ring) so AT announces 'sync' and Tab continues into its rows.
    node.scrollIntoView({ block: 'start' });
    node.focus({ preventScroll: true });
  }, [syncFocusTick]);
  const persistenceColor =
    diagnostics.persistence === 'ok' ? 'secondary' : 'warn';
  return (
    <div
      ref={screenRef}
      tabIndex={-1}
      className="uw-screen uw-settings"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <Text variant="display" color="bright">
        {t('nav.settings')}
      </Text>
      {groups.map((group) => (
        <section key={group.key} className="uw-settings__group">
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label"
          >
            {group.label}
          </Text>
          <div className="uw-card">
            {group.rows.map((row, i) => (
              <div key={row.key}>
                {i > 0 && <Hairline />}
                <SettingsRow
                  row={row}
                  onSelectRow={onSelectRow}
                  onToggleRow={onToggleRow}
                  onConfirmed={(key) => {
                    pendingFocus.current = {
                      key,
                      before: rowOrderRef.current,
                    };
                  }}
                  registerRowEl={(key, el) => {
                    if (el === null) {
                      rowEls.current.delete(key);
                    } else {
                      rowEls.current.set(key, el);
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="uw-settings__group">
      <Text
        variant="label"
        color="secondary"
        uppercase
        className="uw-section-label"
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
      </section>
      {sync !== undefined && (
        <section
          ref={syncSectionRef}
          tabIndex={-1}
          aria-label={t('settings.heading.sync')}
          className="uw-settings__group"
        >
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label"
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
        </section>
      )}
    </div>
  );
}
