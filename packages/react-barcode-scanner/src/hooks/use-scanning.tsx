import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react'

import {
  type ImageProcessingOptions,
  preprocessFrames,
  resolveProcessingOptions
} from '../helper/image-processing'
import { BarcodeFormat, type DetectedBarcode } from '../types'

export type { ImageProcessingOptions }

export interface ScanOptions {
  delay?: number
  formats?: Array<BarcodeFormat | string>
  /**
   * Image preprocessing options to improve detection on
   * low-contrast or difficult-to-read barcodes/QR codes.
   *
   * When enabled (default), if the initial detection attempt
   * fails, the video frame is preprocessed (grayscale conversion,
   * contrast enhancement, adaptive thresholding) and detection
   * is retried on the enhanced image.
   *
   * Set `{ enabled: false }` to disable preprocessing entirely.
   */
  imageProcessing?: ImageProcessingOptions
}

const DEFAULT_OPTIONS = {
  delay: 500,
  formats: ['qr_code']
}

/**
 * Use barcode scanning based on Barcode Detection API.
 * @param ref a RefObject of HTMLVideoElement
 * @param provideOptions a ScanOptions object, provide delay and formats
 * @returns a tuple of detected barcodes, startScan function and stopScan function
 * @example
 * import { type RefObject } from 'react'
 * import { useScanning } from 'react-barcode-scanner'
 *
 * function App () {
 *   const ref = useRef<HTMLVideoElement>(null)
 *   const { detectedBarcodes, startScan, stopScan } = useScanning(ref)
 *
 *   useEffect(() => {
 *     if (detectedBarcodes) {
 *       console.log(detectedBarcodes)
 *     }
 *   }, [detectedBarcodes])
 *
 *   return (
 *     <div>
 *       <button onClick={startScan}>Open</button>
 *       <button onClick={stopScan}>Close</button>
 *       <video ref={ref} />
 *     </div>
 *   )
 * }
 */
export function useScanning (ref: RefObject<HTMLVideoElement | null>, provideOptions?: ScanOptions): {
  detectedBarcodes: DetectedBarcode[] | undefined,
  startScan: () => void,
  stopScan: () => void
  } {
  const [detectedBarcodes, setDetectedBarcodes] = useState<DetectedBarcode[]>()
  const [start, setStart] = useState(false)
  const options = useMemo(() => {
    return Object.assign({}, DEFAULT_OPTIONS, provideOptions)
  }, [provideOptions])

  const processingOptions = useMemo(() => {
    return resolveProcessingOptions(options.imageProcessing)
  }, [options.imageProcessing])

  const scan = useCallback(async () => {
    const target = ref.current
    if (target == null) return

    const detector = new BarcodeDetector({
      formats: options.formats
    })

    // First attempt: detect directly from the video element
    const detected = await detector.detect(target)
    if (detected !== undefined && detected.length > 0) {
      setDetectedBarcodes(detected)
      return
    }

    // Fallback: try each preprocessing strategy lazily until one succeeds.
    // Each pipeline is only computed when the previous one fails,
    // avoiding unnecessary work on expensive strategies.
    if (processingOptions.enabled) {
      const iterator = preprocessFrames(target, processingOptions)
      let result = iterator.next()
      while (!result.done) {
        const enhancedDetected = await detector.detect(result.value!)
        if (enhancedDetected !== undefined && enhancedDetected.length > 0) {
          setDetectedBarcodes(enhancedDetected)
          return
        }
        result = iterator.next()
      }
    }
  }, [ref, options.formats, processingOptions])

  useEffect(() => {
    const target = ref.current
    if (target == null || !start) return

    /**
     * provide `cancelled` tag to prevent `frame` has been
     * triggered but `scan` not fulfilled when call cancelAnimationFrame
     */
    let cancelled = false
    let timer: number
    const frame = async (): Promise<void> => {
      await scan()
      if (!cancelled) {
        timer = window.setTimeout(frame, options.delay)
      }
    }
    frame()
    return () => {
      clearTimeout(timer)
      cancelled = true
    }
  }, [start, ref, options.delay, scan])

  useEffect(() => {
    if (options.formats.length === 0) {
      setStart(false)
    }
  }, [options.formats])

  const startScan = useCallback(() => {
    setStart(true)
  }, [])

  const stopScan = useCallback(() => {
    setStart(false)
  }, [])

  return {
    detectedBarcodes,
    startScan,
    stopScan
  }
}
