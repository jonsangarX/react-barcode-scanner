# @airzone/react-barcode-scanner

Fork interno de [react-barcode-scanner](https://github.com/preflower/react-barcode-scanner) con mejoras de deteccion para QR codes de bajo contraste, especialmente optimizado para tarjetas PCB de Airzone (cobre/dorado sobre fondo verde).

## Instalacion

```bash
pnpm add @airzone/react-barcode-scanner
```

> El paquete se publica en el registry interno: `http://npmreg.airzonesl.es:4873/`

## Uso basico

```tsx
import { BarcodeScanner } from '@airzone/react-barcode-scanner'
import '@airzone/react-barcode-scanner/polyfill'

function App() {
  return (
    <BarcodeScanner
      onCapture={(barcodes) => {
        console.log(barcodes[0].rawValue)
      }}
    />
  )
}
```

## Props del componente

| Prop | Tipo | Default | Descripcion |
|------|------|---------|-------------|
| `onCapture` | `(barcodes: DetectedBarcode[]) => void` | - | Callback cuando se detecta un barcode/QR |
| `options` | `ScanOptions` | `{ delay: 500, formats: ['qr_code'] }` | Opciones de escaneo |
| `trackConstraints` | `MediaTrackConstraints` | Auto (rear camera, 1280x720) | Restricciones de la camara |
| `paused` | `boolean` | `false` | Pausar/reanudar el escaneo |

## ScanOptions

```tsx
interface ScanOptions {
  delay?: number                         // Intervalo de polling en ms (default: 500)
  formats?: Array<BarcodeFormat | string> // Formatos a detectar (default: ['qr_code'])
  imageProcessing?: ImageProcessingOptions // Configuracion del preprocesamiento
}
```

## Preprocesamiento de imagen (image preprocessing)

Esta es la principal mejora respecto a la libreria original. Cuando la deteccion directa falla (tipico en QR codes de bajo contraste), el sistema aplica automaticamente un pipeline de preprocesamiento sobre el frame de video y reintenta la deteccion.

### Como funciona

En cada ciclo de escaneo (500ms por defecto):

1. **Deteccion directa** sobre el elemento `<video>` (rapido, ~ms)
2. Si falla, se ejecutan **5 pipelines de preprocesamiento** de forma lazy (uno a uno, parando en el primero que detecte):

| Orden | Pipeline | Descripcion |
|-------|----------|-------------|
| 1 | `C1-clahered-c3.0-b21-inv-m2` | CLAHE + red channel, contraste 3.0, blockSize 21, inversion, morfologia 5x5 |
| 2 | `C2-clahered-c3.5-b25-inv-m2` | CLAHE + red channel, contraste 3.5, blockSize 25, inversion, morfologia 5x5 |
| 3 | `W1-red-c3.0-b21-inv-m2` | Red channel, contraste 3.0, blockSize 21, inversion, morfologia 5x5 |
| 4 | `W2-red-c3.5-b21-inv-m2` | Red channel, contraste 3.5, blockSize 21, inversion, morfologia 5x5 |
| 5 | `W3-red-c4.5-b31-inv-m2` | Red channel, contraste 4.5, blockSize 31, inversion, morfologia 5x5 |

### Pipeline de procesamiento por cada estrategia

Cada pipeline aplica los siguientes pasos sobre el frame capturado:

1. **Extraccion de canal** - Aisla el canal rojo (o aplica CLAHE + canal rojo en C1/C2)
2. **Mejora de contraste** - Amplificacion lineal centrada en 128
3. **Sharpening** (opcional) - Convolucion 3x3 para acentuar bordes
4. **Adaptive thresholding** - Binarizacion local usando integral image
5. **Closing morfologico** (dilatacion + erosion) - Rellena huecos en modulos del QR
6. **Opening morfologico** (erosion + dilatacion) - Elimina lineas finas de ruido (trazas PCB)
7. **Inversion** - Invierte la imagen (zbar detecta mejor con polaridad invertida en estos casos)

### Por que funciona para las tarjetas Airzone

Las tarjetas PCB tienen un QR serigrafiado en cobre/dorado sobre sustrato verde, con trazas de circuito cruzando la zona del QR. El **canal rojo** es clave porque:

- El cobre tiene alto componente rojo vs el verde del PCB, maximizando el contraste al aislar R
- Las trazas oscuras del circuito colapsan a valores bajos en el canal rojo
- **CLAHE** normaliza la iluminacion desigual antes del resto del pipeline

### Desactivar el preprocesamiento

```tsx
<BarcodeScanner
  options={{
    imageProcessing: { enabled: false }
  }}
  onCapture={handleCapture}
/>
```

## Hooks disponibles

Los hooks son independientes y composables:

```tsx
import { useCamera, useScanning, useTorch } from '@airzone/react-barcode-scanner'
```

| Hook | Descripcion |
|------|-------------|
| `useCamera(ref, constraints?)` | Gestiona el stream de la camara. Retorna `{ isCameraReady, error }` |
| `useScanning(ref, options?)` | Polling de deteccion con preprocesamiento. Retorna `{ detectedBarcodes, startScan, stopScan }` |
| `useTorch()` | Control del flash/linterna del dispositivo. Retorna `{ isTorchSupported, isTorchOn, setIsTorchOn, error }` |

### Ejemplo con hooks

```tsx
import { useRef } from 'react'
import { useCamera, useScanning } from '@airzone/react-barcode-scanner'
import '@airzone/react-barcode-scanner/polyfill'

function CustomScanner() {
  const ref = useRef<HTMLVideoElement>(null)
  const { isCameraReady } = useCamera(ref)
  const { detectedBarcodes, startScan, stopScan } = useScanning(ref, {
    delay: 500,
    formats: ['qr_code'],
  })

  return (
    <div>
      <video ref={ref} style={{ width: '100%' }} autoPlay muted playsInline />
      <button onClick={startScan}>Iniciar</button>
      <button onClick={stopScan}>Parar</button>
      {detectedBarcodes?.map((b, i) => (
        <p key={i}>{b.rawValue}</p>
      ))}
    </div>
  )
}
```

## Polyfill

El import `@airzone/react-barcode-scanner/polyfill` carga automaticamente un polyfill basado en zbar.wasm cuando el navegador no soporta la API nativa `BarcodeDetector`. Es necesario en iOS (Safari < 17.2) y algunos navegadores Android.

```tsx
// Importar una sola vez en el entry point de la app
import '@airzone/react-barcode-scanner/polyfill'
```

## Compatibilidad

| Plataforma | BarcodeDetector nativo | Polyfill (zbar.wasm) |
|------------|----------------------|---------------------|
| Chrome 83+ | Si | - |
| Edge 83+ | Si | - |
| Safari 17.2+ | Si | - |
| Safari < 17.2 / iOS | No | Si (requiere polyfill) |
| Firefox | No | Si (requiere polyfill) |

## Repositorio

- **GitLab (interno):** http://gitlab2.airzonesl.es:30080/airzone-front/react-barcode-scanner
- **Upstream (original):** https://github.com/preflower/react-barcode-scanner

---

## Versionado y publicacion del paquete

El paquete se publica en el registry npm interno de Airzone (`http://npmreg.airzonesl.es:4873/`).

### Bump de version

Desde la raiz del monorepo:

```bash
cd packages/react-barcode-scanner

# Segun el tipo de cambio (semver):
npm version patch   # 4.1.0 → 4.1.1  (bug fix)
npm version minor   # 4.1.0 → 4.2.0  (nueva funcionalidad)
npm version major   # 4.1.0 → 5.0.0  (breaking change)
```

> `npm version` actualiza el `package.json`, crea un commit y un tag de git automaticamente.

### Build y publicar

```bash
# Build (CJS + ESM)
pnpm --filter @airzone/react-barcode-scanner build

# Publicar en el registry interno
cd packages/react-barcode-scanner
npm publish
```

### Verificar la publicacion

```bash
npm info @airzone/react-barcode-scanner --registry http://npmreg.airzonesl.es:4873/
```

### Flujo completo resumido

```bash
# 1. Hacer cambios en el codigo
# 2. Commit + push
git add .
git commit -m "feat(scanning): descripcion del cambio"
git push

# 3. Bump de version
cd packages/react-barcode-scanner
npm version minor

# 4. Push del tag
git push && git push --tags

# 5. Build + publish
pnpm --filter @airzone/react-barcode-scanner build
cd packages/react-barcode-scanner
npm publish
```

## License

MIT
