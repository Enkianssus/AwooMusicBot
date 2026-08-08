export interface WelcomeHintState {
  alreadyShown: boolean;
  configExistedAtStartup: boolean;
  legacyHintWasShown: boolean;
}

export function shouldShowWelcomeHint(state: WelcomeHintState): boolean {
  return (
    !state.alreadyShown
    && !state.configExistedAtStartup
    && !state.legacyHintWasShown
  );
}
