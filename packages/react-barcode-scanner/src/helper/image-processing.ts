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
 * A preprocessing strategy is a function that extracts a single-channel
 * (grayscale) representation from raw RGBA pixel data, optimized for
 * a specific type of image (e.g. standard grayscale, red channel isolation).
 */
type ChannelStrategy = (data: Uint8ClampedArray, length: number) => Uint8Array

/**
 * Standard grayscale conversion using ITU-R BT.601 luma coefficients.
 * Works well for most barcode/QR images with reasonable contrast.
 */
const grayscaleStrategy: ChannelStrategy = (data, length) => {
  const result = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const offset = i * 4
    result[i] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
  }
  return result
}

/**
 * Red channel isolation strategy.
 * Ideal for copper/gold markings on green PCB backgrounds where
 * the red channel contains the strongest contrast between QR
 * modules (high red) and PCB substrate (low red).
 */
const redChannelStrategy: ChannelStrategy = (data, length) => {
  const result = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    result[i] = data[i * 4]
  }
  return result
}

/**
 * Green-subtracted strategy.
 * Computes max(R - G, 0), which maximizes contrast when the
 * foreground is warm-toned (copper/gold) and the background is
 * green-dominant. Circuit traces that are dark in all channels
 * collapse to zero, further cleaning the image.
 */
const greenSubtractedStrategy: ChannelStrategy = (data, length) => {
  const result = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const offset = i * 4
    const diff = data[offset] - data[offset + 1]
    result[i] = diff > 0 ? diff : 0
  }
  return result
}

/**
 * All preprocessing strategies to attempt, in order.
 * The scan loop tries each one until detection succeeds.
 */
const STRATEGIES: ChannelStrategy[] = [
  grayscaleStrategy,
  redChannelStrategy,
  greenSubtractedStrategy
]

/**
 * Generates an array of preprocessed canvas elements from a video
 * frame, one per strategy. Each canvas can be passed directly to
 * BarcodeDetector.detect() as it implements ImageBitmapSource.
 *
 * Pipeline per strategy:
 *   1. Draw video frame onto an offscreen canvas
 *   2. Extract single channel via the strategy function
 *   3. Apply contrast enhancement
 *   4. Apply adaptive thresholding (local binarization)
 *   5. Apply morphological closing (fill small gaps in QR modules)
 *   6. Apply morphological opening (remove thin noise lines)
 */
export function preprocessFrames (
  video: HTMLVideoElement,
  options: Required<ImageProcessingOptions>
): HTMLCanvasElement[] {
  const width = video.videoWidth
  const height = video.videoHeight

  // Capture the raw frame once
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = width
  sourceCanvas.height = height
  const sourceCtx = sourceCanvas.getContext('2d')!
  sourceCtx.drawImage(video, 0, 0, width, height)
  const sourceData = sourceCtx.getImageData(0, 0, width, height)

  return STRATEGIES.map(strategy => {
    return applyPipeline(sourceData, strategy, width, height, options)
  })
}

/**
 * Backwards-compatible single-frame preprocessor.
 * Uses the standard grayscale strategy only.
 */
export function preprocessFrame (
  video: HTMLVideoElement,
  options: Required<ImageProcessingOptions>
): HTMLCanvasElement {
  return preprocessFrames(video, options)[0]
}

/**
 * Applies the full image processing pipeline for a given
 * channel extraction strategy.
 */
function applyPipeline (
  sourceData: ImageData,
  strategy: ChannelStrategy,
  width: number,
  height: number,
  options: Required<ImageProcessingOptions>
): HTMLCanvasElement {
  const { contrast, blockSize, thresholdOffset } = options
  const pixelCount = width * height

  // Step 1: Extract single channel
  const channel = strategy(sourceData.data, pixelCount)

  // Step 2: Contrast enhancement
  //   Maps pixel values so that mid-gray (128) stays fixed
  //   and values spread outward by the contrast factor.
  for (let i = 0; i < pixelCount; i++) {
    const value = contrast * (channel[i] - 128) + 128
    channel[i] = value < 0 ? 0 : value > 255 ? 255 : value
  }

  // Step 3: Adaptive thresholding using integral image
  //   For each pixel, compute the mean of a local neighborhood
  //   and binarize based on whether the pixel is below
  //   (mean - offset). This handles uneven lighting far better
  //   than a global threshold.
  const binarized = adaptiveThreshold(channel, width, height, blockSize, thresholdOffset)

  // Step 4: Morphological closing (dilate then erode)
  //   Fills small gaps inside QR modules that may appear
  //   due to uneven printing or surface texture.
  const closed = dilate(binarized, width, height)
  const closedEroded = erode(closed, width, height)

  // Step 5: Morphological opening (erode then dilate)
  //   Removes thin noise lines (like PCB circuit traces)
  //   that cross through the QR code area.
  const opened = erode(closedEroded, width, height)
  const cleaned = dilate(opened, width, height)

  // Write result to canvas
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const outputData = ctx.createImageData(width, height)
  const out = outputData.data

  for (let i = 0; i < pixelCount; i++) {
    const v = cleaned[i]
    const offset = i * 4
    out[offset] = v
    out[offset + 1] = v
    out[offset + 2] = v
    out[offset + 3] = 255
  }

  ctx.putImageData(outputData, 0, 0)
  return canvas
}

/**
 * Applies adaptive thresholding using a summed-area table
 * (integral image) for O(1) per-pixel neighborhood mean.
 */
function adaptiveThreshold (
  channel: Uint8Array,
  width: number,
  height: number,
  blockSize: number,
  thresholdOffset: number
): Uint8Array {
  const integral = computeIntegralImage(channel, width, height)
  const halfBlock = Math.floor(blockSize / 2)
  const result = new Uint8Array(width * height)

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
      result[idx] = channel[idx] < mean - thresholdOffset ? 0 : 255
    }
  }

  return result
}

/**
 * Morphological dilation with a 3x3 cross structuring element.
 * A pixel becomes white (255) if any of its 4-connected
 * neighbors is white. This expands bright regions.
 */
function dilate (
  src: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const dst = new Uint8Array(src)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (
        src[idx] === 255 ||
        src[idx - 1] === 255 ||
        src[idx + 1] === 255 ||
        src[idx - width] === 255 ||
        src[idx + width] === 255
      ) {
        dst[idx] = 255
      }
    }
  }

  return dst
}

/**
 * Morphological erosion with a 3x3 cross structuring element.
 * A pixel becomes black (0) if any of its 4-connected
 * neighbors is black. This shrinks bright regions and
 * removes thin white lines (noise).
 */
function erode (
  src: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const dst = new Uint8Array(src)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (
        src[idx] === 0 ||
        src[idx - 1] === 0 ||
        src[idx + 1] === 0 ||
        src[idx - width] === 0 ||
        src[idx + width] === 0
      ) {
        dst[idx] = 0
      }
    }
  }

  return dst
}

/**
 * Computes a summed-area table (integral image) from a single-channel
 * buffer. This allows O(1) computation of the sum of any
 * rectangular region, which is essential for fast adaptive
 * thresholding.
 */
function computeIntegralImage (
  channel: Uint8Array,
  width: number,
  height: number
): Float64Array {
  const integral = new Float64Array(width * height)

  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      rowSum += channel[idx]
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
