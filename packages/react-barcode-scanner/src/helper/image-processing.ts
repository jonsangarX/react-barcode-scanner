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

// ---------------------------------------------------------------------------
// Channel extraction strategies
// ---------------------------------------------------------------------------

/**
 * A channel extraction strategy converts raw RGBA pixel data into a
 * single-channel (grayscale) buffer optimized for a specific type
 * of image. Receives width and height to support strategies that
 * need spatial awareness (e.g. CLAHE pre-processing).
 */
type ChannelStrategy = (data: Uint8ClampedArray, length: number, width: number, height: number) => Uint8Array

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
 * CLAHE-pre-enhanced red channel strategy (compound strategy).
 * Extracts the red channel from raw RGBA data, then applies CLAHE
 * to adaptively equalize contrast before returning. This normalizes
 * uneven illumination at the channel level, giving the downstream
 * pipeline (linear contrast + threshold) a much cleaner input signal.
 * Particularly effective for copper-on-green PCBs under varying light.
 */
const clahePreRedStrategy: ChannelStrategy = (data, length, width, height) => {
  const red = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    red[i] = data[i * 4]
  }
  return applyCLAHE(red, width, height, 8, 256, 3.0)
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

interface PipelineConfig {
  /** Descriptive name for debug logging (e.g. 'W1-red-c3.0-b21-inv-m2') */
  name: string
  channel: ChannelStrategy
  contrast: number
  blockSize: number
  thresholdOffset: number
  morphologyRadius: number // 1 = 3x3 cross, 2 = 5x5 cross
  sharpen: boolean
  clahe: boolean
  invert: boolean
}

/**
 * All preprocessing pipelines to attempt. The scan loop tries each
 * one lazily (via PreprocessIterator) until detection succeeds.
 *
 * Pipeline order is informed by extensive field testing with
 * copper-on-green PCB QR codes on iOS and Android. Only the
 * empirically proven winners are included to minimize cycle time
 * on low-end devices:
 *
 *   1. C1-C2 (CLAHE-pre-enhanced red channel): Highest success rate
 *      in field tests. CLAHE normalizes uneven illumination at the
 *      channel level before the rest of the pipeline runs.
 *
 *   2. W1-W3 (red channel + aggressive contrast + inversion):
 *      Lighter fallback that succeeds in some lighting conditions
 *      where CLAHE is not needed.
 *
 * Total worst case: ~400ms (5 pipelines), well within the 500ms
 * scan cycle.
 */
function buildPipelines (): PipelineConfig[] {
  return [
    // --- C: CLAHE-pre-enhanced red channel (highest success rate) ---
    { name: 'C1-clahered-c3.0-b21-inv-m2', channel: clahePreRedStrategy, contrast: 3.0, blockSize: 21, thresholdOffset: 15, morphologyRadius: 2, sharpen: false, clahe: false, invert: true },
    { name: 'C2-clahered-c3.5-b25-inv-m2', channel: clahePreRedStrategy, contrast: 3.5, blockSize: 25, thresholdOffset: 15, morphologyRadius: 2, sharpen: false, clahe: false, invert: true },

    // --- W: proven winners (lighter fallback) ---
    { name: 'W1-red-c3.0-b21-inv-m2', channel: redChannelStrategy, contrast: 3.0, blockSize: 21, thresholdOffset: 15, morphologyRadius: 2, sharpen: false, clahe: false, invert: true },
    { name: 'W2-red-c3.5-b21-inv-m2', channel: redChannelStrategy, contrast: 3.5, blockSize: 21, thresholdOffset: 15, morphologyRadius: 2, sharpen: false, clahe: false, invert: true },
    { name: 'W3-red-c4.5-b31-inv-m2', channel: redChannelStrategy, contrast: 4.5, blockSize: 31, thresholdOffset: 20, morphologyRadius: 2, sharpen: false, clahe: false, invert: true }
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Captures a video frame and returns a lazy iterator that produces
 * one preprocessed canvas per pipeline configuration. Each canvas
 * is only computed when next() is called, so if an early strategy
 * succeeds the remaining (more expensive) pipelines are never run.
 *
 * Each returned canvas can be passed directly to
 * BarcodeDetector.detect() as it implements ImageBitmapSource.
 */
export function preprocessFrames (
  video: HTMLVideoElement,
  _options: Required<ImageProcessingOptions>
): PreprocessIterator {
  const width = video.videoWidth
  const height = video.videoHeight

  // Capture the raw frame once and share across all pipelines
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = width
  sourceCanvas.height = height
  const sourceCtx = sourceCanvas.getContext('2d')!
  sourceCtx.drawImage(video, 0, 0, width, height)
  const sourceData = sourceCtx.getImageData(0, 0, width, height)

  const pipelines = buildPipelines()

  return new PreprocessIterator(sourceData, pipelines, width, height)
}

/**
 * Lazy iterator over preprocessing pipelines. Computes one canvas
 * at a time, only when next() is called.
 */
class PreprocessIterator {
  private sourceData: ImageData
  private pipelines: PipelineConfig[]
  private width: number
  private height: number
  private index: number

  constructor (sourceData: ImageData, pipelines: PipelineConfig[], width: number, height: number) {
    this.sourceData = sourceData
    this.pipelines = pipelines
    this.width = width
    this.height = height
    this.index = 0
  }

  next (): { done: boolean, value: HTMLCanvasElement | undefined } {
    if (this.index >= this.pipelines.length) {
      return { done: true, value: undefined }
    }
    const canvas = applyPipeline(
      this.sourceData,
      this.pipelines[this.index],
      this.width,
      this.height
    )
    this.index++
    return { done: false, value: canvas }
  }
}

/**
 * Backwards-compatible single-frame preprocessor.
 */
export function preprocessFrame (
  video: HTMLVideoElement,
  options: Required<ImageProcessingOptions>
): HTMLCanvasElement {
  return preprocessFrames(video, options).next().value!
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

function applyPipeline (
  sourceData: ImageData,
  config: PipelineConfig,
  width: number,
  height: number
): HTMLCanvasElement {
  const pixelCount = width * height

  // Step 1: Extract single channel
  let channel = config.channel(sourceData.data, pixelCount, width, height)

  // Step 2: CLAHE (before linear contrast, replaces it when enabled)
  if (config.clahe) {
    channel = applyCLAHE(channel, width, height, 8, 256, 3.0)
  }

  // Step 3: Linear contrast enhancement
  if (config.contrast !== 1) {
    channel = applyContrast(channel, config.contrast)
  }

  // Step 4: Sharpen (3x3 unsharp-mask style kernel)
  if (config.sharpen) {
    channel = applySharpen(channel, width, height)
  }

  // Step 5: Adaptive thresholding
  let binarized = adaptiveThreshold(
    channel, width, height,
    config.blockSize, config.thresholdOffset
  )

  // Step 6: Morphological closing (fills gaps in QR modules)
  binarized = morphClose(binarized, width, height, config.morphologyRadius)

  // Step 7: Morphological opening (removes thin noise lines)
  binarized = morphOpen(binarized, width, height, config.morphologyRadius)

  // Step 8: Inversion (optional)
  if (config.invert) {
    for (let i = 0; i < pixelCount; i++) {
      binarized[i] = binarized[i] === 0 ? 255 : 0
    }
  }

  // Write result to canvas
  return toCanvas(binarized, width, height)
}

// ---------------------------------------------------------------------------
// Image processing primitives
// ---------------------------------------------------------------------------

function applyContrast (channel: Uint8Array, contrast: number): Uint8Array {
  const result = new Uint8Array(channel.length)
  for (let i = 0; i < channel.length; i++) {
    const value = contrast * (channel[i] - 128) + 128
    result[i] = value < 0 ? 0 : value > 255 ? 255 : value
  }
  return result
}

/**
 * Contrast Limited Adaptive Histogram Equalization (CLAHE).
 *
 * Divides the image into tiles, computes a contrast-limited
 * histogram equalization per tile, and bilinearly interpolates
 * between tiles for a smooth result. This handles uneven
 * illumination much better than global histogram equalization.
 */
function applyCLAHE (
  channel: Uint8Array,
  width: number,
  height: number,
  tilesXY: number,
  bins: number,
  clipLimit: number
): Uint8Array {
  const result = new Uint8Array(channel.length)
  const tileW = Math.ceil(width / tilesXY)
  const tileH = Math.ceil(height / tilesXY)

  // Build LUTs for each tile
  const luts: Uint8Array[][] = []

  for (let ty = 0; ty < tilesXY; ty++) {
    luts[ty] = []
    for (let tx = 0; tx < tilesXY; tx++) {
      const x0 = tx * tileW
      const y0 = ty * tileH
      const x1 = Math.min(x0 + tileW, width)
      const y1 = Math.min(y0 + tileH, height)

      // Build histogram
      const hist = new Float64Array(bins)
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[channel[y * width + x]]++
          count++
        }
      }

      // Clip histogram and redistribute
      const limit = Math.max(1, (clipLimit * count) / bins)
      let excess = 0
      for (let i = 0; i < bins; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit
          hist[i] = limit
        }
      }
      const increment = excess / bins
      for (let i = 0; i < bins; i++) {
        hist[i] += increment
      }

      // Build CDF → LUT
      const lut = new Uint8Array(bins)
      let cdf = 0
      for (let i = 0; i < bins; i++) {
        cdf += hist[i]
        lut[i] = Math.min(255, Math.round((cdf / count) * 255))
      }

      luts[ty][tx] = lut
    }
  }

  // Bilinear interpolation between tile LUTs
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const px = channel[idx]

      // Fractional tile position (center of each tile)
      const fx = (x / tileW) - 0.5
      const fy = (y / tileH) - 0.5

      const tx0 = Math.max(0, Math.floor(fx))
      const ty0 = Math.max(0, Math.floor(fy))
      const tx1 = Math.min(tilesXY - 1, tx0 + 1)
      const ty1 = Math.min(tilesXY - 1, ty0 + 1)

      const dx = Math.max(0, Math.min(1, fx - tx0))
      const dy = Math.max(0, Math.min(1, fy - ty0))

      const tl = luts[ty0][tx0][px]
      const tr = luts[ty0][tx1][px]
      const bl = luts[ty1][tx0][px]
      const br = luts[ty1][tx1][px]

      result[idx] = Math.round(
        tl * (1 - dx) * (1 - dy) +
        tr * dx * (1 - dy) +
        bl * (1 - dx) * dy +
        br * dx * dy
      )
    }
  }

  return result
}

/**
 * 3x3 sharpening convolution.
 * Kernel:  [ 0, -1,  0 ]
 *          [-1,  5, -1 ]
 *          [ 0, -1,  0 ]
 */
function applySharpen (
  channel: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const result = new Uint8Array(channel.length)
  // Copy border pixels unchanged
  result.set(channel)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const value =
        5 * channel[idx] -
        channel[idx - 1] -
        channel[idx + 1] -
        channel[idx - width] -
        channel[idx + width]

      result[idx] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }

  return result
}

/**
 * Adaptive thresholding using integral image for O(1) per-pixel
 * neighborhood mean computation.
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

// ---------------------------------------------------------------------------
// Morphological operations with configurable radius
// ---------------------------------------------------------------------------

/**
 * Morphological dilation with a cross structuring element of
 * the given radius (1 = 3x3, 2 = 5x5).
 */
function dilate (
  src: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const dst = new Uint8Array(src)

  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const idx = y * width + x
      if (src[idx] === 255) { dst[idx] = 255; continue }

      let found = false
      for (let r = 1; r <= radius && !found; r++) {
        if (
          src[idx - r] === 255 ||
          src[idx + r] === 255 ||
          src[idx - r * width] === 255 ||
          src[idx + r * width] === 255
        ) {
          found = true
        }
      }
      if (found) dst[idx] = 255
    }
  }

  return dst
}

/**
 * Morphological erosion with a cross structuring element of
 * the given radius (1 = 3x3, 2 = 5x5).
 */
function erode (
  src: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const dst = new Uint8Array(src)

  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const idx = y * width + x
      if (src[idx] === 0) { dst[idx] = 0; continue }

      let found = false
      for (let r = 1; r <= radius && !found; r++) {
        if (
          src[idx - r] === 0 ||
          src[idx + r] === 0 ||
          src[idx - r * width] === 0 ||
          src[idx + r * width] === 0
        ) {
          found = true
        }
      }
      if (found) dst[idx] = 0
    }
  }

  return dst
}

/** Morphological closing: dilate then erode. Fills small gaps. */
function morphClose (src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(src, w, h, r), w, h, r)
}

/** Morphological opening: erode then dilate. Removes thin noise. */
function morphOpen (src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilate(erode(src, w, h, r), w, h, r)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanvas (buffer: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const out = imageData.data

  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i]
    const offset = i * 4
    out[offset] = v
    out[offset + 1] = v
    out[offset + 2] = v
    out[offset + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

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
