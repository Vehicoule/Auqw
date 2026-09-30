import { Clipboard, Linking } from 'react-native';
import { createAuthSession } from '@auqw/application';
import type { AuthShellPort } from '@auqw/app-shell';
import { createSecureAuthCustody } from './secure-auth.ts';

/**
 * The mobile AuthShellPort: the application `AuthSession` over
 * expo-secure-store custody with the host's in-memory token slot as
 * `applyToken`. `restore()` is kicked at construction — it's memoized
 * and pushes through the subscription, so a sheet opening before it
 * settles still sees the restored state.
 *
 * Only status + the device pair cross this surface — refresh/access
 * tokens never reach the UI layer.
 */
export function createMobileAuth(controller: {
  setAuthToken(token: string | null): void;
}): AuthShellPort {
  const session = createAuthSession({
    custody: createSecureAuthCustody(),
    applyToken: (token) => controller.setAuthToken(token),
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
    copyText: (text) => Clipboard.setString(text),
    openUrl: (url) => {
      void Linking.openURL(url).catch(() => undefined);
    },
  };
}
