import type { ReactNode } from 'react';
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';
import { Hairline, Icon, PillButton, Pressable, Text } from './primitives.tsx';
import { QrCode } from './qr-code.tsx';
import type { SyncModel, SyncPeerModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type SyncScreenProps = {
  readonly model: SyncModel;
  readonly topInset?: number | undefined;
  readonly onBack?: (() => void) | undefined;
  /**
   * Typed-code pair — `host:port` is the manual endpoint the spec's
   * typed path needs (the desktop shows it next to its code).
   */
  readonly onPairCode?:
    | ((input: { code: string; host: string; port: number | null }) => void)
    | undefined;
  /** QR-payload pair — the scanned JSON string, verbatim. */
  readonly onPairPayload?: ((payload: string) => void) | undefined;
  readonly onSyncNow?: ((fp: string) => void) | undefined;
  readonly onUnpair?: ((fp: string) => void) | undefined;
  /**
   * A pair request is in flight — both entry paths disable until it
   * settles so a slow dial can't double-submit.
   */
  readonly pairing?: boolean | undefined;
  /** Last pair failure's typed message — rendered under the form. */
  readonly pairError?: string | null | undefined;
  /**
   * Symmetric pairing — this device hosting an offer (QR + code the
   * other side scans/types). `active` means the listener + mDNS
   * advertise are live; the offer stays minted while shown.
   */
  readonly share?:
    | {
        readonly supported: boolean;
        readonly active: boolean;
        readonly busy: boolean;
        readonly code: string | null;
        readonly payload: string | null;
        /**
         * `ip:port` the typed-code path dials — same endpoint the
         * desktop shows beside its code. Null pre-start.
         */
        readonly endpoint?: string | null | undefined;
        readonly expiresLabel: string | null;
      }
    | undefined;
  readonly onShareToggle?: (() => void) | undefined;
  /** Copies the live offer's payload — the desktop's clipboard path. */
  readonly onCopyPayload?: (() => void) | undefined;
  /**
   * mDNS-discovered pair hosts — tap a row, then type the code that
   * device is showing. `key` is stable for the session.
   */
  readonly nearbyPeers?:
    | readonly {
        readonly key: string;
        readonly name: string;
        readonly address: string;
        /** fp pinned via TXT — true means the dial can verify it. */
        readonly pinned: boolean;
      }[]
    | undefined;
  readonly onPairNearby?:
    | ((key: string, code: string) => void)
    | undefined;
  /**
   * The host app's QR scanner — a mounted CameraView is passed down
   * because expo-camera is a mobile-dep, not a ui-native one. Absent
   * (gallery, web, permission denied), the section hides.
   */
  readonly renderScanner?:
    | ((onScan: (data: string) => void) => ReactNode)
    | undefined;
  /**
   * Clipboard delta exchange — the desktop settings panel's copy/
   * paste pair. Absent means the host has no delta seam; the section
   * then hides rather than dead-press.
   */
  readonly onExportDelta?: (() => void) | undefined;
  readonly onImportDelta?: (() => void) | undefined;
};

function fieldBox(theme: Theme) {
  return {
    borderRadius: theme.radius.control,
    borderWidth: theme.strokes.hairline,
    borderColor: theme.colors.hairline,
    overflow: 'hidden' as const,
  };
}

const digits6 = (next: string) =>
  next.replace(/[^0-9]/g, '').slice(0, 6);

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.xl }}>
      <Text
        variant="label"
        color="secondary"
        uppercase
        style={{
          paddingHorizontal: theme.spacing.screen,
          marginBottom: theme.spacing.sm,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          marginHorizontal: theme.spacing.screen,
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function PeerRow({
  peer,
  onSyncNow,
  onUnpair,
}: {
  readonly peer: SyncPeerModel;
  readonly onSyncNow?: ((fp: string) => void) | undefined;
  readonly onUnpair?: ((fp: string) => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View style={{ padding: 14, gap: theme.spacing.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="body" color="primary" style={{ flex: 1 }} numberOfLines={1}>
          {peer.name}
        </Text>
        <Text
          variant="metadata"
          color={peer.state === 'open' ? 'accent' : 'secondary'}
        >
          {peer.stateLabel}
        </Text>
      </View>
      <Text variant="metadata" color="secondary" numberOfLines={1}>
        {[
          peer.endpointLabel,
          peer.lastSyncLabel,
        ]
          .filter((s) => s !== null)
          .join(' · ') || t('sync.fpFallback', { fp: peer.fpShort })}
      </Text>
      {peer.lastError !== null && (
        <Text variant="metadata" color="warn" numberOfLines={2}>
          {peer.lastError}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: theme.spacing.xs }}>
        <Pressable
          onPress={onSyncNow === undefined ? undefined : () => onSyncNow(peer.key)}
          disabled={onSyncNow === undefined || peer.syncing}
          accessibilityLabel={t('sync.syncNowA11y', { name: peer.name })}
          accessibilityRole="button"
          style={({ pressed }) => [{ opacity: peer.syncing || pressed ? 0.5 : 1 }]}
        >
          <Text variant="metadata" color="accent">
            {peer.syncing ? t('sync.syncing') : t('sync.syncNow')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onUnpair === undefined ? undefined : () => onUnpair(peer.key)}
          disabled={onUnpair === undefined}
          accessibilityLabel={t('sync.unpairA11y', { name: peer.name })}
          accessibilityRole="button"
          style={({ pressed }) => [pressed && { opacity: 0.5 }]}
        >
          <Text variant="metadata" color="warn">
            {t('sync.unpair')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function PairForm({
  disabled,
  error,
  onPairCode,
}: {
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onPairCode?:
    | ((input: { code: string; host: string; port: number | null }) => void)
    | undefined;
}) {
  const theme = useTheme();
  const [code, setCode] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const codeReady = /^[0-9]{6}$/.test(code);
  const hostReady = host.trim().length > 0;
  const parsedPort = port.trim() === '' ? null : Number.parseInt(port, 10);
  const portReady =
    parsedPort !== null &&
    Number.isSafeInteger(parsedPort) &&
    parsedPort > 0 &&
    parsedPort <= 65535;
  const ready = codeReady && hostReady && portReady && !disabled;
  const inputStyle = [
    theme.typography.body,
    {
      flex: 1,
      color: theme.colors.textPrimary,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.screen,
    },
  ];
  return (
    <View style={{ padding: 14, gap: theme.spacing.sm }}>
      <Text variant="metadata" color="secondary">
        {t('sync.form.help')}
      </Text>
      <View style={[{ flexDirection: 'row' }, fieldBox(theme)]}>
        <TextInput
          value={code}
          onChangeText={(next) => setCode(digits6(next))}
          placeholder="123456"
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="number-pad"
          maxLength={6}
          accessibilityLabel={t('sync.form.codeA11y')}
          style={inputStyle}
        />
      </View>
      <View style={[{ flexDirection: 'row' }, fieldBox(theme)]}>
        <TextInput
          value={host}
          onChangeText={setHost}
          placeholder={t('sync.form.host')}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel={t('sync.form.host')}
          style={inputStyle}
        />
        <View
          style={{
            width: 96,
            borderLeftWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
          }}
        >
          <TextInput
            value={port}
            onChangeText={(next) =>
              setPort(next.replace(/[^0-9]/g, '').slice(0, 5))
            }
            placeholder={t('sync.form.port')}
            placeholderTextColor={theme.colors.textSecondary}
            keyboardType="number-pad"
            maxLength={5}
            accessibilityLabel={t('sync.form.portA11y')}
            style={inputStyle}
          />
        </View>
      </View>
      {error !== null && (
        <Text variant="metadata" color="warn">
          {error}
        </Text>
      )}
      <PillButton
        label={disabled ? t('sync.form.pairing') : t('sync.form.pair')}
        tone="accent"
        onPress={
          onPairCode === undefined || !ready
            ? undefined
            : () =>
                onPairCode({
                  code,
                  host: host.trim(),
                  port: parsedPort,
                })
        }
        disabled={onPairCode === undefined || !ready}
        accessibilityLabel={t('sync.form.pair')}
        style={{ alignSelf: 'flex-start' }}
      />
    </View>
  );
}

/**
 * The paste fallback for payload pairing — the desktop sheet's raw
 * paste row, for when neither a camera scan nor a nearby advert is
 * available (screenshot relayed out-of-band, say).
 */
function PayloadPasteForm({
  disabled,
  onPairPayload,
}: {
  readonly disabled: boolean;
  readonly onPairPayload?: ((payload: string) => void) | undefined;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const ready = draft.trim() !== '';
  return (
    <View
      style={{
        padding: 14,
        gap: theme.spacing.sm,
      }}
    >
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={t('sync.form.payload')}
        placeholderTextColor={theme.colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        accessibilityLabel={t('sync.form.payloadA11y')}
        style={[
          theme.typography.body,
          fieldBox(theme),
          {
            color: theme.colors.textPrimary,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.screen,
            minHeight: 40,
          },
        ]}
      />
      <PillButton
        label={t('sync.form.usePayload')}
        tone="accent"
        onPress={
          onPairPayload === undefined || !ready
            ? undefined
            : () => onPairPayload(draft.trim())
        }
        disabled={onPairPayload === undefined || !ready || disabled}
        accessibilityLabel={t('sync.form.usePayload')}
        style={{ alignSelf: 'flex-start' }}
      />
    </View>
  );
}

function ShareSection({
  share,
  onToggle,
  onCopyPayload,
}: {
  readonly share: NonNullable<SyncScreenProps['share']>;
  readonly onToggle?: (() => void) | undefined;
  readonly onCopyPayload?: (() => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View style={{ padding: 14, gap: theme.spacing.sm }}>
      <Text variant="metadata" color="secondary">
        {t('sync.shareHint')}
      </Text>
      {share.active && share.payload !== null && share.code !== null ? (
        <>
          <QrCode data={share.payload} />
          <Text
            variant="title"
            color="bright"
            style={{ textAlign: 'center', letterSpacing: 6 }}
          >
            {share.code}
          </Text>
          {share.endpoint !== null && share.endpoint !== undefined && (
            <Text
              variant="metadata"
              color="secondary"
              style={{ textAlign: 'center' }}
            >
              {t('pairing.typeHint')}{' '}
              <Text variant="metadata" color="primary">
                {share.endpoint}
              </Text>
            </Text>
          )}
          {share.expiresLabel !== null && (
            <Text
              variant="metadata"
              color="secondary"
              style={{ textAlign: 'center' }}
            >
              {share.expiresLabel}
            </Text>
          )}
          {onCopyPayload !== undefined && (
            <Pressable
              onPress={onCopyPayload}
              accessibilityLabel={t('pairing.copyPayloadA11y')}
              accessibilityRole="button"
              style={({ pressed }) => [
                {
                  alignSelf: 'flex-start',
                  paddingVertical: theme.spacing.xs,
                },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text variant="metadata" color="accent">
                {t('pairing.copyPayload')}
              </Text>
            </Pressable>
          )}
        </>
      ) : null}
      <Pressable
        onPress={onToggle}
        disabled={onToggle === undefined || share.busy}
        accessibilityLabel={
          share.active ? t('sync.shareStop') : t('sync.shareStart')
        }
        accessibilityRole="button"
        style={({ pressed }) => [
          {
            alignSelf: 'flex-start',
            paddingHorizontal: 18,
            paddingVertical: 8,
            borderRadius: theme.radius.control,
            backgroundColor: share.active
              ? theme.colors.hairline
              : theme.colors.accent,
          },
          (share.busy || pressed) && { opacity: 0.5 },
        ]}
      >
        <Text
          variant="metadata"
          color={share.active ? 'primary' : 'bright'}
        >
          {share.busy
            ? t('sync.form.pairing')
            : share.active
              ? t('sync.shareStop')
              : t('sync.shareStart')}
        </Text>
      </Pressable>
    </View>
  );
}

function NearbyRow({
  peer,
  disabled,
  onPair,
}: {
  readonly peer: NonNullable<SyncScreenProps['nearbyPeers']>[number];
  readonly disabled: boolean;
  readonly onPair?: ((key: string, code: string) => void) | undefined;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const ready = /^[0-9]{6}$/.test(code);
  return (
    <View style={{ padding: 14, gap: theme.spacing.xs }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        disabled={onPair === undefined}
        accessibilityLabel={t('sync.nearby.codeFor', { name: peer.name })}
        accessibilityRole="button"
        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
          }}
        >
          <Icon
            name="radio"
            size={14}
            color={theme.colors.textPrimary}
          />
          <Text
            variant="body"
            color="primary"
            style={{ flex: 1 }}
            numberOfLines={1}
          >
            {peer.name}
          </Text>
          <Text variant="metadata" color="secondary">
            {peer.address}
          </Text>
        </View>
      </Pressable>
      {open && (
        <View
          style={{ flexDirection: 'row', gap: theme.spacing.sm }}
        >
          <TextInput
            value={code}
            onChangeText={(next) => setCode(digits6(next))}
            placeholder={t('sync.nearby.codeFor', { name: peer.name })}
            placeholderTextColor={theme.colors.textSecondary}
            keyboardType="number-pad"
            maxLength={6}
            accessibilityLabel={t('sync.form.codeA11y')}
            style={[
              theme.typography.body,
              fieldBox(theme),
              {
                flex: 1,
                color: theme.colors.textPrimary,
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.screen,
              },
            ]}
          />
          <Pressable
            onPress={
              !ready || onPair === undefined
                ? undefined
                : () => onPair(peer.key, code)
            }
            disabled={!ready || onPair === undefined || disabled}
            accessibilityLabel={t('sync.nearby.connect')}
            accessibilityRole="button"
            style={({ pressed }) => [
              {
                paddingHorizontal: 18,
                justifyContent: 'center',
                borderRadius: theme.radius.control,
                backgroundColor: theme.colors.accent,
              },
              (!ready || disabled || pressed) && { opacity: 0.5 },
            ]}
          >
            <Text variant="metadata" color="bright">
              {t('sync.nearby.connect')}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export function SyncScreen({
  model,
  topInset = 0,
  onBack,
  onPairCode,
  onPairPayload,
  onSyncNow,
  onUnpair,
  pairing = false,
  pairError = null,
  share,
  onShareToggle,
  onCopyPayload,
  nearbyPeers,
  onPairNearby,
  renderScanner,
  onExportDelta,
  onImportDelta,
}: SyncScreenProps) {
  const theme = useTheme();
  const [scanning, setScanning] = useState(false);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{
        paddingTop: topInset,
        paddingBottom: theme.spacing.xxl,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: theme.spacing.screen,
          minHeight: theme.sizes.touch,
          gap: theme.spacing.sm,
        }}
      >
        <Pressable
          onPress={onBack}
          disabled={onBack === undefined}
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
          style={({ pressed }) => [pressed && { opacity: 0.5 }]}
        >
          <Icon
            name="chevron-left"
            size={16}
            color={theme.colors.textPrimary}
          />
        </Pressable>
        <Text variant="title" color="primary">
          {t('sync.title')}
        </Text>
      </View>

      {!model.available ? (
        <View
          style={{
            marginHorizontal: theme.spacing.screen,
            marginTop: theme.spacing.xl,
            padding: 14,
            borderRadius: theme.radius.control,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
          }}
        >
          <Text variant="metadata" color="secondary">
            {t('sync.unavailable')}
          </Text>
        </View>
      ) : (
        <>
          <View
            style={{
              paddingHorizontal: theme.spacing.screen,
              marginTop: theme.spacing.sm,
            }}
          >
            <Text variant="metadata" color="secondary">
              {model.statusLabel}
              {model.deviceId === null
                ? ''
                : t('sync.deviceIdSuffix', { id: model.deviceId })}
            </Text>
          </View>

          {share?.supported === true && (
            <Section title={t('sync.share')}>
              <ShareSection
                share={share}
                onToggle={onShareToggle}
                onCopyPayload={onCopyPayload}
              />
            </Section>
          )}

          {nearbyPeers !== undefined && onPairNearby !== undefined && (
            <Section title={t('sync.nearby')}>
              <View style={{ padding: 14 }}>
                <Text variant="metadata" color="secondary">
                  {nearbyPeers.length === 0
                    ? t('sync.nearby.none')
                    : t('sync.nearby.tap')}
                </Text>
              </View>
              {nearbyPeers.map((peer) => (
                <View key={peer.key}>
                  <Hairline />
                  <NearbyRow
                    peer={peer}
                    disabled={pairing}
                    onPair={onPairNearby}
                  />
                </View>
              ))}
            </Section>
          )}

          {model.peers.length > 0 && (
            <Section title={t('sync.section.devices')}>
              {model.peers.map((peer, i) => (
                <View key={peer.key}>
                  {i > 0 && <Hairline style={{ marginLeft: 14 }} />}
                  <PeerRow
                    peer={peer}
                    onSyncNow={onSyncNow}
                    onUnpair={onUnpair}
                  />
                </View>
              ))}
            </Section>
          )}

          <Section title={t('sync.section.pair')}>
            {renderScanner !== undefined && (
              <>
                {scanning ? (
                  <View style={{ height: 260 }}>
                    {renderScanner((data) => {
                      setScanning(false);
                      onPairPayload?.(data);
                    })}
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setScanning(true)}
                    disabled={pairing}
                    accessibilityLabel={t('sync.scanA11y')}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      { padding: 14 },
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text variant="metadata" color="accent">
                      {t('sync.scan')}
                    </Text>
                  </Pressable>
                )}
                <Hairline />
              </>
            )}
            <PairForm
              disabled={pairing}
              error={pairError}
              onPairCode={onPairCode}
            />
            {onPairPayload !== undefined && (
              <>
                <Hairline />
                <PayloadPasteForm
                  disabled={pairing}
                  onPairPayload={onPairPayload}
                />
              </>
            )}
          </Section>

          {(onExportDelta !== undefined || onImportDelta !== undefined) && (
            <Section title={t('sync.panel.deltaExchange')}>
              <View
                style={{
                  flexDirection: 'row',
                  gap: theme.spacing.md,
                  padding: 14,
                }}
              >
                {(
                  [
                    [onExportDelta, 'sync.panel.copyDelta'],
                    [onImportDelta, 'sync.panel.pasteDelta'],
                  ] as const
                ).map(
                  ([fn, key]) =>
                    fn !== undefined && (
                      <Pressable
                        key={key}
                        onPress={fn}
                        accessibilityLabel={t(key)}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          pressed && { opacity: 0.5 },
                        ]}
                      >
                        <Text variant="metadata" color="accent">
                          {t(key)}
                        </Text>
                      </Pressable>
                    ),
                )}
              </View>
          </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}
