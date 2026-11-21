import type { ViewerFitOptions } from '@file-viewer/web-full'

export const isImagePreview = (name: string) => /\.(png|jpe?g|svg|gif|webp|avif|bmp|ico|heic|heif|tiff?)$/iu.test(name)

export const imageFit = { mode: 'scale-down', resize: 'until-interaction', padding: 24 } satisfies ViewerFitOptions

export type ImagePreviewAction = 'rotate' | 'zoom-out' | 'fit' | 'zoom-in'

export interface ImagePreviewState {
  label: string
  canZoomIn: boolean
  canZoomOut: boolean
  pages?: string
}
