// Native biometric helper. Uses @aparajita/capacitor-biometric-auth on Android (Samsung
// fingerprint / face via BiometricPrompt). Falls through gracefully on web or if the
// plugin isn't installed yet — caller should fall back to PIN.

import { Capacitor } from '@capacitor/core';
import i18n from '../i18n';

interface BiometricCapability {
  available: boolean;
  reason: string;
}

interface BiometricAuthModule {
  BiometricAuth: {
    checkBiometry: () => Promise<{ isAvailable: boolean; reason?: string; strongBiometryIsAvailable?: boolean }>;
    authenticate: (options?: {
      reason?: string;
      cancelTitle?: string;
      androidTitle?: string;
      androidSubtitle?: string;
      androidConfirmationRequired?: boolean;
    }) => Promise<void>;
  };
}

let cached: BiometricAuthModule | null | undefined;

async function loadPlugin(): Promise<BiometricAuthModule | null> {
  if (cached !== undefined) return cached;
  if (!Capacitor.isNativePlatform()) {
    cached = null;
    return null;
  }
  try {
    cached = (await import('@aparajita/capacitor-biometric-auth')) as unknown as BiometricAuthModule;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export async function biometricCapability(): Promise<BiometricCapability> {
  if (!Capacitor.isNativePlatform()) {
    return { available: false, reason: 'Biometric unlock is only available on Android.' };
  }
  const mod = await loadPlugin();
  if (!mod) {
    return { available: false, reason: 'Biometric plugin not installed (run npm install + cap sync).' };
  }
  try {
    const result = await mod.BiometricAuth.checkBiometry();
    if (!result.isAvailable) {
      return { available: false, reason: result.reason ?? 'No biometrics enrolled.' };
    }
    return { available: true, reason: 'Ready.' };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

export async function authenticateBiometric(): Promise<{ ok: boolean; reason?: string }> {
  const cap = await biometricCapability();
  if (!cap.available) return { ok: false, reason: cap.reason };
  const mod = await loadPlugin();
  if (!mod) return { ok: false, reason: 'Plugin missing.' };
  try {
    await mod.BiometricAuth.authenticate({
      // v1.22 (NCC#263): the system sheet in the app's language.
      reason: i18n.t('auth.bio.reason'),
      androidTitle: i18n.t('auth.bio.title'),
      androidSubtitle: i18n.t('auth.bio.subtitle'),
      cancelTitle: i18n.t('auth.bio.cancel'),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message ?? 'Authentication cancelled.' };
  }
}
