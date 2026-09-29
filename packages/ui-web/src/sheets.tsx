import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthSheetModel, PairingModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import type { ProviderPickerOption } from '@auqw/ui-shared';
import { Artwork, DiagPressRow, Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { bindTo } from './track-row.tsx';
import { useOverlayDismiss, useOverlayFocus } from './stack.tsx';
import { sheetKeyAction } from './keyboard.ts';
import { QrCode } from './qr-code.tsx';

/**
 * Sheet building blocks: the content frame (title row + actions) plus
 * a name field matching the search-field treatment, reused by the
 * Slice-2 sheets — row actions and the add-to-playlist picker. The
 * modal chrome (scrim + dialog) is `Sheet`'s job; the block-level
 * sheets stay plain panels so hosts can place them. Sheets own no
 * state beyond the draft name; every action delegates.
 */

export type SheetAction = {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly destructive?: boolean | undefined;
};

function SheetScaffold({
  title,
  onDismiss,
  children,
}: {
  readonly title: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="uw-sheet-panel">
      <div className="uw-sheet-panel__head">
        <Text variant="heading" color="bright" className="uw-sheet-panel__title">
          {title}
        </Text>
        <Pressable
          onPress={onDismiss}
          ariaLabel={t('common.close')}
          className="uw-sheet-panel__close"
        >
          <Icon name="close" size={14} color="var(--text-secondary)" />
        </Pressable>
      </div>
      {children}
    </div>
  );
}

/**
 * The modal host — scrim + dialog panel. Mounts only when `open`;
 * Escape and scrim click dismiss, matching the native sheet's swipe.
 */
export function Sheet({
  open,
  label,
  onDismiss,
  children,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  // Escape ownership comes from the stack when mounted inside one —
  // a push under this sheet keeps its listener silent until the sheet
  // unregisters on close.
  useOverlayDismiss(open ? onDismiss : undefined);
  if (!open) {
    return null;
  }
  return <SheetDialog label={label} onDismiss={onDismiss}>{children}</SheetDialog>;
}

// Separate component so focus entry/restore tracks the open/close
// mount boundary exactly (Sheet itself stays mounted while closed).
function SheetDialog({
  label,
  onDismiss,
  children,
}: {
  readonly label: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const dialogRef = useOverlayFocus<HTMLDivElement>();
  return (
    <div className="uw-sheet-host" data-sheet="panel">
      <button
        type="button"
        className="uw-scrim"
        aria-label={t('sheets.closeA11y')}
        tabIndex={-1}
        onClick={onDismiss}
      />
      <div
        ref={dialogRef}
        className="uw-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

// The sheet forms' rounded field — `digits` clamps to a numeric keypad
// (pairing code/port); a plain text input otherwise.
function Field(p: {
  readonly value: string;
  readonly set: (value: string) => void;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly digits?: number | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <input
      className={`uw-namefield__input${p.className ? ` ${p.className}` : ''}`}
      aria-label={p.ariaLabel}
      placeholder={p.placeholder}
      autoComplete="off"
      spellCheck={p.digits === undefined ? false : undefined}
      inputMode={p.digits === undefined ? undefined : 'numeric'}
      maxLength={p.digits}
      value={p.value}
      onChange={(event) =>
        p.set(
          p.digits === undefined
            ? event.currentTarget.value
            : event.currentTarget.value
                .replace(/[^0-9]/g, '')
                .slice(0, p.digits),
        )
      }
    />
  );
}

// One `uw-sheet-row` pressable — every sheet list row shares the shell.
function SheetRow({
  onPress,
  ariaLabel,
  ariaSelected,
  dashed = false,
  children,
}: {
  readonly onPress?: (() => void) | undefined;
  readonly ariaLabel: string;
  readonly ariaSelected?: boolean | undefined;
  readonly dashed?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={ariaLabel}
      ariaSelected={ariaSelected}
      className={`uw-sheet-row${dashed ? ' uw-sheet-row--dashed' : ''}`}
    >
      {children}
    </Pressable>
  );
}

// Accent pill submit — the pair/connect/apply affordance.
function PillAction(p: {
  readonly label: string;
  readonly onPress?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      ariaLabel={p.label}
      className="uw-pill uw-pill--accent"
    >
      <Text variant="metadata" color="bright">
        {p.label}
      </Text>
    </Pressable>
  );
}

type PairCodeInput = {
  readonly code: string;
  readonly host: string;
  readonly port: number | null;
};
type OnPairCode = ((input: PairCodeInput) => void) | undefined;

/**
 * Field + confirm/cancel row — the same rounded-field treatment the
 * search bar uses, reused by the new-playlist flow and the picker.
 */
export function NameField({
  value,
  placeholder,
  submitLabel = t('common.create'),
  autoFocus = false,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly submitLabel?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly onSubmit?: ((value: string) => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
}) {
  const trimmed = value.trim();
  return (
    <div className="uw-namefield">
      <input
        className="uw-namefield__input"
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        readOnly={onChange === undefined}
        onChange={
          onChange === undefined
            ? undefined
            : (event) => onChange(event.currentTarget.value)
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onSubmit !== undefined && trimmed !== '') {
            onSubmit(trimmed);
          }
          if (sheetKeyAction(event.key) === 'close' && onCancel !== undefined) {
            // The field consumes Escape before the overlay sees it —
            // cancel stays local, the sheet stays open. When no
            // onCancel exists the key still bubbles to the dismisser.
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {onSubmit !== undefined && (
        <Pressable
          onPress={trimmed === '' ? undefined : () => onSubmit(trimmed)}
          ariaLabel={submitLabel}
          className="uw-namefield__action"
        >
          <Text
            variant="metadata"
            color={trimmed === '' ? 'secondary' : 'accent'}
          >
            {submitLabel}
          </Text>
        </Pressable>
      )}
      {onCancel !== undefined && (
        <Pressable
          onPress={onCancel}
          ariaLabel={t('common.cancel')}
          className="uw-namefield__action"
        >
          <Text variant="metadata" color="secondary">
            {t('common.cancel')}
          </Text>
        </Pressable>
      )}
    </div>
  );
}

/**
 * Single-value editor sheet — free-form settings values like the
 * storefront's ISO-3166 alpha-2 code. `onSubmit` gets the trimmed
 * draft; the caller validates and dismisses on accept. `clearLabel`
 * renders a dashed reset row for values with an auto/null state.
 */
export function ValueFieldSheet({
  title,
  initial = '',
  placeholder,
  submitLabel = t('common.save'),
  clearLabel,
  onSubmit,
  onClear,
  onDismiss,
}: {
  readonly title: string;
  readonly initial?: string | undefined;
  readonly placeholder: string;
  readonly submitLabel?: string | undefined;
  readonly clearLabel?: string | undefined;
  readonly onSubmit?: ((value: string) => void) | undefined;
  readonly onClear?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      <NameField
        value={draft}
        placeholder={placeholder}
        submitLabel={submitLabel}
        autoFocus
        onChange={setDraft}
        onSubmit={onSubmit}
        onCancel={onDismiss}
      />
      {clearLabel !== undefined && onClear !== undefined && (
        <SheetRow onPress={onClear} ariaLabel={clearLabel} dashed>
          <Icon name="close" size={15} color="var(--text-secondary)" />
          <Text variant="body" color="secondary">
            {clearLabel}
          </Text>
        </SheetRow>
      )}
    </SheetScaffold>
  );
}

export function RowActionsSheet({
  title,
  actions,
  onAction,
  onDismiss,
}: {
  readonly title: string;
  readonly actions: readonly SheetAction[];
  readonly onAction?: ((key: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      <div role="menu" aria-label={title}>
        {actions.map((action) => (
          <SheetRow
            key={action.key}
            onPress={bindTo(onAction, action.key)}
            ariaLabel={action.label}
          >
            <Icon
              name={action.icon}
              size={15}
              color={
                action.destructive === true
                  ? 'var(--warn)'
                  : 'var(--text-secondary)'
              }
            />
            <Text
              variant="body"
              color={action.destructive === true ? 'warn' : 'primary'}
            >
              {action.label}
            </Text>
          </SheetRow>
        ))}
      </div>
    </SheetScaffold>
  );
}

/**
 * One settings slot's provider choices — only providers that
 * declared the slot's capability reach `options` (the caller gates);
 * the selected option reads accent + check, never a fake default.
 */
export function ProviderPickerSheet({
  title = t('sheets.providerTitle'),
  options,
  selectedKey,
  onPick,
  onDismiss,
}: {
  readonly title?: string | undefined;
  readonly options: readonly ProviderPickerOption[];
  readonly selectedKey: string | null;
  readonly onPick?: ((key: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {options.length === 0 ? (
        <div className="uw-sheet-row" data-state="unavailable">
          <Icon name="warn" size={15} color="var(--warn)" />
          <Text variant="body" color="secondary">
            {t('sheets.noProvider')}
          </Text>
        </div>
      ) : (
        options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <SheetRow
              key={option.key}
              onPress={bindTo(onPick, option.key)}
              ariaLabel={option.label}
              ariaSelected={selected}
            >
              <span className="uw-sheet-row__text">
                <Text
                  variant="body"
                  color={selected ? 'accent' : 'primary'}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
                {option.detail != null && (
                  <Text variant="metadata" color="secondary" numberOfLines={1}>
                    {option.detail}
                  </Text>
                )}
              </span>
              {selected && (
                <Icon name="check" size={14} color="var(--accent)" />
              )}
            </SheetRow>
          );
        })
      )}
    </SheetScaffold>
  );
}

export type PlaylistPickerItem = {
  readonly playlistId: string;
  readonly name: string;
  readonly count: number;
  readonly artworkUrl: string | null;
};

export function AddToPlaylistSheet({
  title = t('sheets.addToPlaylist'),
  playlists,
  onPick,
  onCreate,
  onDismiss,
}: {
  readonly title?: string | undefined;
  readonly playlists: readonly PlaylistPickerItem[];
  readonly onPick?: ((playlistId: string) => void) | undefined;
  readonly onCreate?: ((name: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {playlists.map((playlist) => (
        <SheetRow
          key={playlist.playlistId}
          onPress={bindTo(onPick, playlist.playlistId)}
          ariaLabel={t('sheets.itemA11y', { name: playlist.name, count: playlist.count })}
        >
          <Artwork url={playlist.artworkUrl} size={40} />
          <span className="uw-sheet-row__text">
            <Text variant="body" color="primary" numberOfLines={1}>
              {playlist.name}
            </Text>
            <Text variant="metadata" color="secondary">
              {t('common.trackCount', { count: playlist.count })}
            </Text>
          </span>
        </SheetRow>
      ))}
      {creating ? (
        <NameField
          value={draft}
          placeholder={t('common.newPlaylistName')}
          autoFocus
          onChange={setDraft}
          onSubmit={
            onCreate === undefined
              ? undefined
              : (name) => {
                onCreate(name);
                setDraft('');
                setCreating(false);
              }
          }
          onCancel={() => {
            setDraft('');
            setCreating(false);
          }}
        />
      ) : (
        <SheetRow
          onPress={onCreate === undefined ? undefined : () => setCreating(true)}
          ariaLabel={t('common.newPlaylist')}
          dashed
        >
          <Icon name="list-plus" size={15} color="var(--text-secondary)" />
          <Text variant="body" color="secondary">
            {t('common.newPlaylist')}
          </Text>
        </SheetRow>
      )}
    </SheetScaffold>
  );
}

type NearbyPeerModel = {
  readonly key: string;
  readonly name: string;
  readonly address: string;
  /** fp pinned via TXT — the dial verifies it during handshake. */
  readonly pinned: boolean;
};

function NearbyRow({
  peer,
  disabled,
  onPair,
}: {
  readonly peer: NearbyPeerModel;
  readonly disabled: boolean;
  readonly onPair: ((key: string, code: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const ready = /^[0-9]{6}$/.test(code);
  return (
    <div className="uw-nearby__row">
      <DiagPressRow
        label={peer.name}
        ariaLabel={t('sync.nearby.codeFor', { name: peer.name })}
        kColor="primary"
        onPress={() => setOpen((v) => !v)}
        disabled={onPair === undefined}
      >
        <Text variant="metadata" color="secondary">
          {peer.address}
        </Text>
      </DiagPressRow>
      {open && (
        <div className="uw-nearby__dial">
          <Field
            value={code}
            set={setCode}
            ariaLabel={t('sync.form.codeA11y')}
            placeholder={t('sync.nearby.codeFor', { name: peer.name })}
            digits={6}
          />
          <PillAction
            label={t('sync.nearby.connect')}
            onPress={
              !ready || onPair === undefined
                ? undefined
                : () => onPair(peer.key, code)
            }
            disabled={!ready || onPair === undefined || disabled}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The manual join form — the desktop's typed path where mobile has a
 * camera: code + host + port, mirroring the mobile PairForm exactly.
 * `port` stays a draft string so an empty box means "no port yet",
 * never a hidden default.
 */
function ManualPairForm({
  disabled,
  onPairCode,
}: {
  readonly disabled: boolean;
  readonly onPairCode?: OnPairCode;
}) {
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
  return (
    <div className="uw-manual-pair">
      <Text variant="metadata" color="secondary">
        {t('sync.form.help')}
      </Text>
      <div className="uw-nearby__dial">
        <Field
          value={code}
          set={setCode}
          ariaLabel={t('sync.form.codeA11y')}
          placeholder="123456"
          digits={6}
        />
      </div>
      <div className="uw-nearby__dial">
        <Field
          value={host}
          set={setHost}
          ariaLabel={t('sync.form.host')}
          placeholder={t('sync.form.host')}
        />
        <Field
          value={port}
          set={setPort}
          ariaLabel={t('sync.form.portA11y')}
          placeholder={t('sync.form.port')}
          digits={5}
          className="uw-manual-pair__port"
        />
      </div>
      <div className="uw-nearby__dial">
        <PillAction
          label={disabled ? t('sync.form.pairing') : t('sync.form.pair')}
          onPress={
            !ready || onPairCode === undefined
              ? undefined
              : () =>
                onPairCode({ code, host: host.trim(), port: parsedPort })
          }
          disabled={!ready || onPairCode === undefined}
        />
      </div>
    </div>
  );
}

/**
 * The pairing offer: the QR another device scans, plus the code.
 * Below it the accept half — nearby pair hosts discovered over mDNS
 * (tap → type the code that device is showing), a typed code+address
 * form for off-network or discovery-free joins, and a raw-payload
 * paste fallback. `expiresLabel` counts down to the offer's expiry.
 * `pairing` is null while the offer mints or after it failed — the
 * accept half must work either way, so it renders unconditionally.
 */
export function PairingSheet({
  pairing,
  onCopyPayload,
  onDismiss,
  nearbyPeers,
  onPairNearby,
  onPairCode,
  onPastePayload,
  dialing = false,
  dialError = null,
}: {
  readonly pairing: PairingModel | null;
  readonly onCopyPayload?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly nearbyPeers?: readonly NearbyPeerModel[] | undefined;
  readonly onPairNearby?: ((key: string, code: string) => void) | undefined;
  /**
   * Typed join: code + host + port — the desktop's join-by-address
   * path (it has no camera; the QR scanner is a mobile surface).
   */
  readonly onPairCode?: OnPairCode;
  readonly onPastePayload?: ((payload: string) => void) | undefined;
  readonly dialing?: boolean | undefined;
  readonly dialError?: string | null | undefined;
}) {
  const [payloadDraft, setPayloadDraft] = useState('');
  return (
    <SheetScaffold title={t('sync.pairDevice')} onDismiss={onDismiss}>
      <div className="uw-pairing">
        {pairing !== null && (
          <>
            <div className="uw-pairing__qr">
              <QrCode data={pairing.payload} />
            </div>
            <Text variant="metadata" color="secondary">
              {t('pairing.scanHint')}
            </Text>
            <Text
              variant="title"
              color="bright"
              numeric
              className="uw-pairing__code"
            >
              {pairing.code}
            </Text>
            <Text variant="metadata" color="secondary">
              {t('pairing.typeHint')}{' '}
              <Text
                variant="metadata"
                color="primary"
                className="uw-pairing__endpoint"
              >
                {pairing.endpointLabel}
              </Text>{' '}
              · {pairing.expiresLabel}
            </Text>
            <DiagPressRow
              label={t('pairing.copyPayload')}
              ariaLabel={t('pairing.copyPayloadA11y')}
              onPress={onCopyPayload}
            >
              <Icon name="check" size={12} color="var(--text-secondary)" />
            </DiagPressRow>
          </>
        )}
        {nearbyPeers !== undefined && onPairNearby !== undefined && (
          <div className="uw-nearby">
            <Text variant="metadata" color="secondary">
              {nearbyPeers.length === 0
                ? t('sync.nearby.none')
                : t('sync.nearby.tap')}
            </Text>
            {nearbyPeers.map((peer) => (
              <NearbyRow
                key={peer.key}
                peer={peer}
                disabled={dialing}
                onPair={onPairNearby}
              />
            ))}
          </div>
        )}
        {onPairCode !== undefined && (
          <ManualPairForm disabled={dialing} onPairCode={onPairCode} />
        )}
        {onPastePayload !== undefined && (
          <div className="uw-nearby__dial">
            <Field
              value={payloadDraft}
              set={setPayloadDraft}
              ariaLabel={t('sync.form.payloadA11y')}
              placeholder={t('sync.form.payload')}
            />
            <PillAction
              label={t('sync.form.usePayload')}
              onPress={
                payloadDraft.trim() === ''
                  ? undefined
                  : () => onPastePayload(payloadDraft.trim())
              }
              disabled={payloadDraft.trim() === '' || dialing}
            />
          </div>
        )}
        {dialError !== null && (
          <Text variant="metadata" color="warn">
            {dialError}
          </Text>
        )}
      </div>
    </SheetScaffold>
  );
}

/**
 * OAuth device-flow sheet — the shared shell drives the poll; this
 * renders the status union. 'authorizing' shows the user code +
 * verification link (copy/open are platform callbacks); 'signed-in'
 * carries the sign-out affordance; 'failed' pairs the localized
 * reason with retry. Dismissal is the caller's cancel — the sheet
 * owns no flow state itself.
 */
export function AuthSheet({
  model,
  onCopyCode,
  onOpenLink,
  onRetry,
  onSignOut,
  onDismiss,
}: {
  readonly model: AuthSheetModel;
  readonly onCopyCode?: ((code: string) => void) | undefined;
  readonly onOpenLink?: ((url: string) => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onSignOut?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const code = model.userCode;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [code]);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <SheetScaffold title={t('auth.sheet.title')} onDismiss={onDismiss}>
      {model.state === 'signed-out' && (
        <Text variant="body" color="secondary">
          {t('auth.sheet.intro')}
        </Text>
      )}
      {model.state === 'starting' && (
        <div className="uw-sheet-row" data-state="busy">
          <Icon name="spinner" size={15} color="var(--accent)" />
          <Text variant="body" color="secondary">
            {t('auth.sheet.starting')}
          </Text>
        </div>
      )}
      {model.state === 'authorizing' && (
        <>
          <Text variant="body" color="secondary">
            {t('auth.sheet.codeHint')}
          </Text>
          {code !== null && (
            <div className="uw-auth-code" aria-label={code}>
              <Text variant="heading" color="bright">
                {code}
              </Text>
            </div>
          )}
          {code !== null && onCopyCode !== undefined && (
            <SheetRow
              onPress={() => {
                onCopyCode(code);
                setCopied(true);
              }}
              ariaLabel={t('auth.sheet.copyCode')}
            >
              <Icon
                name={copied ? 'check' : 'note'}
                size={15}
                color={
                  copied ? 'var(--accent)' : 'var(--text-secondary)'
                }
              />
              <Text
                variant="body"
                color={copied ? 'accent' : 'primary'}
              >
                {copied ? t('auth.sheet.copied') : t('auth.sheet.copyCode')}
              </Text>
            </SheetRow>
          )}
          {model.verificationUrl !== null && onOpenLink !== undefined && (
            <SheetRow
              onPress={() => onOpenLink(model.verificationUrl as string)}
              ariaLabel={t('auth.sheet.openLink')}
            >
              <Icon
                name="chevron-right"
                size={15}
                color="var(--text-secondary)"
              />
              <Text variant="body" color="primary">
                {t('auth.sheet.openLink')}
              </Text>
            </SheetRow>
          )}
          <div className="uw-sheet-row" data-state="busy">
            <Icon name="spinner" size={15} color="var(--accent)" />
            <Text variant="metadata" color="secondary">
              {t('auth.sheet.waiting')}
            </Text>
          </div>
        </>
      )}
      {model.state === 'signed-in' && (
        <>
          <div className="uw-sheet-row">
            <Icon name="check" size={15} color="var(--accent)" />
            <Text variant="body" color="secondary">
              {t('auth.sheet.linked')}
            </Text>
          </div>
          {onSignOut !== undefined && (
            <SheetRow
              onPress={onSignOut}
              ariaLabel={t('auth.sheet.signOut')}
            >
              <Icon name="close" size={15} color="var(--warn)" />
              <Text variant="body" color="warn">
                {t('auth.sheet.signOut')}
              </Text>
            </SheetRow>
          )}
        </>
      )}
      {model.state === 'failed' && (
        <>
          <div className="uw-sheet-row" data-state="unavailable">
            <Icon name="warn" size={15} color="var(--warn)" />
            <Text variant="body" color="warn">
              {model.errorMessage ?? t('error.generic')}
            </Text>
          </div>
          {onRetry !== undefined && (
            <SheetRow onPress={onRetry} ariaLabel={t('auth.sheet.retry')}>
              <Icon
                name="spinner"
                size={15}
                color="var(--text-secondary)"
              />
              <Text variant="body" color="primary">
                {t('auth.sheet.retry')}
              </Text>
            </SheetRow>
          )}
        </>
      )}
    </SheetScaffold>
  );
}
