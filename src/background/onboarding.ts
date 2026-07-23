import { markOnboardingPending } from '../shared/onboarding';

/** Open Settings on first install so users configure a translation provider. */
export function registerInstallOnboarding(initialized: Promise<void>): void {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;

    void initialized.then(() => markOnboardingPending()).then(() => {
      void browser.runtime.openOptionsPage();
    });
  });
}
