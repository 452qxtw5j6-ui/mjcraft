export interface OpenSessionStatusMenuEventDetail {
  sessionId?: string
}

export function dispatchOpenSessionStatusMenuEvent(detail: OpenSessionStatusMenuEventDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenSessionStatusMenuEventDetail>('craft:open-session-status-menu', { detail }))
}
