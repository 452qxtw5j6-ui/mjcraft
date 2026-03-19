export interface OpenModelMenuEventDetail {
  sessionId?: string
}

export function dispatchOpenModelMenuEvent(detail: OpenModelMenuEventDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenModelMenuEventDetail>('craft:open-model-menu', { detail }))
}
