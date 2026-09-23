import type { ReactNode } from 'react';
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Hairline, Icon, Pressable, Text } from './primitives.tsx';
import type { SyncModel, SyncPeerModel } from '@auqw/ui-shared';

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
   * The host app's QR scanner — a mounted CameraView is passed down
   * because expo-camera is a mobile-dep, not a ui-native one. Absent
   * (gallery, web, permission denied), the section hides.
   */
  readonly renderScanner?:
    | ((onScan: (data: string) => void) => ReactNode)
    | undefined;
};

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
  const stateColor = peer.state === 'open' ? 'accent' : 'secondary';
  return (
    <View style={{ padding: 14, gap: theme.spacing.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="body" color="primary" style={{ flex: 1 }} numberOfLines={1}>
          {peer.name}
        </Text>
        <Text variant="metadata" color={stateColor}>
          {peer.stateLabel}
        </Text>
      </View>
      <Text variant="metadata" color="secondary" numberOfLines={1}>
        {[
          peer.endpointLabel,
          peer.lastSyncLabel,
        ]
          .filter((s) => s !== null)
          .join(' · ') || `fp ${peer.fpShort}…`}
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
          accessibilityLabel={`sync now ${peer.name}`}
          accessibilityRole="button"
          style={({ pressed }) => [{ opacity: peer.syncing || pressed ? 0.5 : 1 }]}
        >
          <Text variant="metadata" color="accent">
            {peer.syncing ? 'syncing…' : 'sync now'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onUnpair === undefined ? undefined : () => onUnpair(peer.key)}
          disabled={onUnpair === undefined}
          accessibilityLabel={`unpair ${peer.name}`}
          accessibilityRole="button"
          style={({ pressed }) => [pressed && { opacity: 0.5 }]}
        >
          <Text variant="metadata" color="warn">
            unpair
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
        type the 6-digit code shown on the desktop with its
        address:port — e.g. 192.168.1.20 and 48715
      </Text>
      <View
        style={{
          flexDirection: 'row',
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          overflow: 'hidden',
        }}
      >
        <TextInput
          value={code}
          onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
          placeholder="123456"
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="number-pad"
          maxLength={6}
          accessibilityLabel="pairing code"
          style={inputStyle}
        />
      </View>
      <View
        style={{
          flexDirection: 'row',
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          overflow: 'hidden',
        }}
      >
        <TextInput
          value={host}
          onChangeText={setHost}
          placeholder="desktop address"
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="desktop address"
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
            onChangeText={(t) => setPort(t.replace(/[^0-9]/g, '').slice(0, 5))}
            placeholder="port"
            placeholderTextColor={theme.colors.textSecondary}
            keyboardType="number-pad"
            maxLength={5}
            accessibilityLabel="desktop port"
            style={inputStyle}
          />
        </View>
      </View>
      {error !== null && (
        <Text variant="metadata" color="warn">
          {error}
        </Text>
      )}
      <Pressable
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
        accessibilityLabel="pair"
        accessibilityRole="button"
        style={({ pressed }) => [
          {
            alignSelf: 'flex-start',
            paddingHorizontal: 18,
            paddingVertical: 8,
            borderRadius: theme.radius.control,
            backgroundColor: theme.colors.accent,
          },
          (!ready || pressed) && { opacity: 0.5 },
        ]}
      >
        <Text variant="metadata" color="bright">
          {disabled ? 'pairing…' : 'pair'}
        </Text>
      </Pressable>
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
  renderScanner,
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
          accessibilityLabel="back"
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
          desktop sync
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
            sync isn't available on this device yet
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
              {model.deviceId === null ? '' : ` · id ${model.deviceId}`}
            </Text>
          </View>

          {model.peers.length > 0 && (
            <Section title="devices">
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

          <Section title="pair">
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
                    accessibilityLabel="scan QR code"
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      { padding: 14 },
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text variant="metadata" color="accent">
                      scan the QR shown on the desktop
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
          </Section>
        </>
      )}
    </ScrollView>
  );
}
