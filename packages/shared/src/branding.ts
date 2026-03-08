/**
 * Centralized branding assets.
 * Used by OAuth callback pages, app chrome, and deeplink helpers.
 */

export const APP_NAME = 'Noodle';
export const APP_PROTOCOL_SCHEME = 'noodle';
export const APP_BACKEND_NAME = 'Noodle Backend';
export const APP_DOCS_NAME = 'Noodle Docs';

export const APP_LOGO = [
  '███╗   ██╗ ██████╗  ██████╗ ██████╗ ██╗     ███████╗',
  '████╗  ██║██╔═══██╗██╔═══██╗██╔══██╗██║     ██╔════╝',
  '██╔██╗ ██║██║   ██║██║   ██║██║  ██║██║     █████╗  ',
  '██║╚██╗██║██║   ██║██║   ██║██║  ██║██║     ██╔══╝  ',
  '██║ ╚████║╚██████╔╝╚██████╔╝██████╔╝███████╗███████╗',
] as const;

export const CRAFT_LOGO = APP_LOGO;

/** Logo as a single string for HTML templates */
export const APP_LOGO_HTML = APP_LOGO.map((line) => line.trimEnd()).join('\n');
export const CRAFT_LOGO_HTML = APP_LOGO_HTML;

export function buildAppUrl(route: string): string {
  const normalizedRoute = route.replace(/^\/+/, '');
  return `${APP_PROTOCOL_SCHEME}://${normalizedRoute}`;
}

export function isAppUrl(url: string): boolean {
  return url.startsWith(`${APP_PROTOCOL_SCHEME}://`);
}

/** Session viewer base URL */
export const VIEWER_URL = 'https://agents.craft.do';
