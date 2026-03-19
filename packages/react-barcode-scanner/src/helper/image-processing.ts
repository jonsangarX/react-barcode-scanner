export interface ImageProcessingOptions {
  /**
   * Whether to enable image preprocessing as fallback
   * when direct detection fails.
   * @default true
   */
  enabled?: boolean
  /**
   * Contrast multiplier applied during preprocessing.
   * Values > 1 increase contrast, values < 1 decrease it.
   * @default 1.8
   */
  contrast?: number
  /**
   * Size of the local neighborhood (in pixels) used for
   * adaptive thresholding. Must be an odd number.
   * Larger values are more tolerant of gradual lighting changes.
   * @default 15
   */
  blockSize?: number
  /**
   * Constant subtracted from the local mean during adaptive
   * thresholding. Higher values make the binarization more
   * aggressive (more pixels become black).
   * @default 10
   */
  thresholdOffset?: number
}

const DEFAULT_PROCESSING_OPTIONS: Required<ImageProcessingOptions> = {
  enabled: true,
  contrast: 1.8,
  blockSize: 15,
  thresholdOffset: 10
}

/**
 * Resolves the image processing options by merging user-provided
 * values with defaults.
 */
export function resolveProcessingOptions (
  options?: ImageProcessingOptions
): Required<ImageProcessingOptions> {
  return Object.assign({}, DEFAULT_PROCESSING_OPTIONS, options)
}

/**
 * Preprocesses a video frame to improve barcode/QR detection
 * on low-contrast images.
 *
 * Pipeline:
 *   1. Draw video frame onto an offscreen canvas
 *   2. Convert to grayscale
 *   3. Apply contrast enhancement
 *   4. Apply adaptive thresholding (local binarization)
 *
 * Returns the canvas element, which can be passed directly to
 * BarcodeDetector.detect() as it implements ImageBitmapSource.
 */
export function preprocessFrame (
  video: HTMLVideoElement,
  options: Required<ImageProcessingOptions>
): HTMLCanvasElement {
  const { contrast, blockSize, thresholdOffset } = options
  const width = video.videoWidth
  const height = video.videoHeight

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  // Step 1: Convert to grayscale
  const grayscale = new Uint8Array(width * height)
  for (let i = 0; i < grayscale.length; i++) {
    const offset = i * 4
    // ITU-R BT.601 luma coefficients
    grayscale[i] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
  }

  // Step 2: Apply contrast enhancement
  //   Maps pixel values so that mid-gray (128) stays fixed
  //   and values spread outward by the contrast factor.
  for (let i = 0; i < grayscale.length; i++) {
    const value = contrast * (grayscale[i] - 128) + 128
    grayscale[i] = value < 0 ? 0 : value > 255 ? 255 : value
  }

  // Step 3: Adaptive thresholding using integral image
  //   For each pixel, compute the mean of a local neighborhood
  //   and binarize based on whether the pixel is below
  //   (mean - offset). This handles uneven lighting far better
  //   than a global threshold.
  const integral = computeIntegralImage(grayscale, width, height)
  const halfBlock = Math.floor(blockSize / 2)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - halfBlock)
      const y1 = Math.max(0, y - halfBlock)
      const x2 = Math.min(width - 1, x + halfBlock)
      const y2 = Math.min(height - 1, y + halfBlock)

      const count = (x2 - x1 + 1) * (y2 - y1 + 1)
      const sum = getIntegralSum(integral, width, x1, y1, x2, y2)
      const mean = sum / count

      const idx = y * width + x
      const outputValue = grayscale[idx] < mean - thresholdOffset ? 0 : 255

      const offset = idx * 4
      data[offset] = outputValue
      data[offset + 1] = outputValue
      data[offset + 2] = outputValue
      // alpha channel stays at 255
    }
  }

  ctx.putImageData(imageData, 0, 0)

  return canvas
}

/**
 * Computes a summed-area table (integral image) from a grayscale
 * buffer. This allows O(1) computation of the sum of any
 * rectangular region, which is essential for fast adaptive
 * thresholding.
 */
function computeIntegralImage (
  grayscale: Uint8Array,
  width: number,
  height: number
): Float64Array {
  const integral = new Float64Array(width * height)

  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      rowSum += grayscale[idx]
      integral[idx] = rowSum + (y > 0 ? integral[(y - 1) * width + x] : 0)
    }
  }

  return integral
}

/**
 * Returns the sum of pixel values within a rectangle using the
 * integral image. Uses the inclusion-exclusion principle.
 */
function getIntegralSum (
  integral: Float64Array,
  width: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const bottomRight = integral[y2 * width + x2]
  const topRight = y1 > 0 ? integral[(y1 - 1) * width + x2] : 0
  const bottomLeft = x1 > 0 ? integral[y2 * width + (x1 - 1)] : 0
  const topLeft = y1 > 0 && x1 > 0 ? integral[(y1 - 1) * width + (x1 - 1)] : 0

  return bottomRight - topRight - bottomLeft + topLeft
}
