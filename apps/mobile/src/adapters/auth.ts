import { Clipboard, Linking } from 'react-native';
import { appError, createAuthSession } from '@auqw/application';
import type { AuthShellPort } from '@auqw/app-shell';
import { createSecureAuthCustody } from './secure-auth.ts';

/**
 * The mobile AuthShellPort: the application `AuthSession` over
 * expo-secure-store custody with the host's in-memory token slot as
 * `applyToken`. `restore()` is kicked at construction — it's memoized
 * and pushes through the subscription, so a sheet opening before it
 * settles still sees the restored state. An absent native slot (a
 * stale module predating the auth seam) fails the apply — claiming
 * liveness on an empty slot would render linked-but-dead as live.
 *
 * Only status + the device pair cross this surface — refresh/access
 * tokens never reach the UI layer. `dispose` ends the session's
 * timers and lanes; it must run at the owning view's teardown — an
 * orphaned session keeps renewing the grant and can re-arm the host
 * bearer after a later session signs out.
 */
export function createMobileAuth(controller: {
  setAuthToken(token: string | null): boolean;
}): AuthShellPort & { dispose(): void } {
  const session = createAuthSession({
    custody: createSecureAuthCustody(),
    applyToken: (token) => {
      if (!controller.setAuthToken(token)) {
        throw appError('unavailable', 'auth: host token slot absent');
      }
    },
  });
  void session.restore();
  return {
    snapshot: () => session.snapshot(),
    subscribe: (listener) => session.subscribe(listener),
    beginSignIn: () => session.beginSignIn(),
    cancelSignIn: () => session.cancelSignIn(),
    signOut: () => session.signOut(),
    retryNow: () => session.retryNow(),
    setClientOverride: (clientId) => session.setClientOverride(clientId),
    dispose: () => session.dispose(),
    copyText: (text) => Clipboard.setString(text),
    openUrl: (url) => {
      void Linking.openURL(url).catch(() => undefined);
    },
  };
}
