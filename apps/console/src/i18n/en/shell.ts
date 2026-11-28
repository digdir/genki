import type { Translation } from '@genai/i18n';
import type { shell as source } from '../nb/shell';

export const shell = {
  groupPlatform: 'Platform',
  pageAtlas: 'System atlas',
  skipLink: 'Skip to main content',
  menu: 'Menu',
  menuLabel: 'Console menu',
  title: 'Operations console',
  lockdownReadOnly:
    'Locked test platform: you can look around, but changes, models and ingestion need an Entra ID login.',
  envLocal: 'Local',
  envProduction: 'Production',
  logout: 'Sign out',
  checkingLogin: 'Checking your sign-in',
  loggedOutTitle: 'You are signed out',
  loggedOutText: 'Your session has expired. Sign in again to continue where you were.',
  retryAfterFailure: '{message} Try again.',
  login: 'Sign in',
  loginIntro: "For Digdir's operations team. Sign in with your Digdir account.",
  loginWithAccount: 'Sign in with Digdir account',
  refusedTitle: 'You do not have access to the operations console',
  refusedText:
    "You are signed in as {name}. The operations console is only for Digdir's operations team. Your account is missing the operations role.",
  refusedNotOperator:
    "The operations console is only for Digdir's operations team. The account you signed in with is missing the operations role.",
  refusedHelp: 'If you need access, your manager can ask for the operations role for you.',
  notFound: 'Page not found',
  notFoundHelp: 'Check the address, or go to Organisations.',
} satisfies Translation<typeof source>;
