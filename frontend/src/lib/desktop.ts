export type UpdateState = {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}
export type OcrSetupState = { status: 'idle' | 'installing' | 'ready' | 'error' | 'unsupported'; message?: string }

export interface DesktopApi {
  /** 'hidden' when the window has no system title bar and the page must leave room for the window buttons. */
  titleBar: 'hidden' | 'native'
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<boolean>
  onUpdateState(callback: (state: UpdateState) => void): () => void
  getOcrSetupState(): Promise<OcrSetupState>
  installOcr(): Promise<OcrSetupState>
  onOcrSetupState(callback: (state: OcrSetupState) => void): () => void
}

declare global { interface Window { pdferDesktop?: DesktopApi } }
