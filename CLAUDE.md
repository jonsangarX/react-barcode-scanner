# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React Barcode Scanner — a React component library for barcode/QR code scanning using the browser's Barcode Detection API with a zbar.wasm polyfill fallback. Published as `react-barcode-scanner` on npm.

## Monorepo Structure

pnpm workspaces monorepo with two packages:
- `packages/react-barcode-scanner` — the main library (dual CJS/ESM build)
- `packages/docs` — Next.js + Nextra documentation site (en-US / zh-CN)

## Common Commands

```bash
# Install dependencies
pnpm install

# Build the library (CJS to lib/, ESM to esm/)
pnpm --filter react-barcode-scanner build

# Build CJS only
pnpm --filter react-barcode-scanner build:cjs

# Build ESM only
pnpm --filter react-barcode-scanner build:es

# Lint (root)
pnpm lint        # runs: eslint .

# Run docs dev server (builds library first, then starts Next.js)
pnpm --filter docs dev

# Release flow (CI)
pnpm ci:version  # changesets version + lockfile update
pnpm ci:publish  # build + changesets publish
```

There is no test suite in this project.

## Architecture

The library exposes a `<BarcodeScanner>` component and composable hooks. All source lives in `packages/react-barcode-scanner/src/`.

**Component**: `BarcodeScanner` renders an HTML5 `<video>` element and composes `useCamera` + `useScanning` hooks. It accepts standard video element props plus `options`, `onCapture`, `trackConstraints`, and `paused`.

**Hooks** (all independently usable):
- `useCamera` — acquires camera stream via `getUserMedia()`, manages lifecycle/cleanup, stores the `MediaStream` in a shared atom
- `useScanning` — polls the video element with `BarcodeDetector.detect()` at a configurable interval (default 1000ms)
- `useTorch` — controls device flashlight via `MediaTrackConstraints` (non-standard `torch` capability)
- `useStreamState` / `useAtom` — minimal atom-based shared state so hooks can share the same `MediaStream` instance across component boundaries without external state libraries

**Browser compatibility layer**:
- `helper/shimGetUserMedia.ts` — applies `webrtc-adapter` shims per detected browser
- `shims/media-stream.d.ts` — type augmentations for non-standard APIs (`torch`, `mozSrcObject`)
- `polyfill.ts` — lazy-loads `BarcodeDetectorPolyfill` only when native `BarcodeDetector` is unavailable (separate entry point at `react-barcode-scanner/polyfill`)

**Type system**: `types.ts` declares `BarcodeFormat`, `DetectedBarcode`, and globally augments `BarcodeDetector` class since it's not yet in standard TypeScript lib definitions.

## Build & TypeScript

- Target: ES5, JSX: react-jsx, strict mode
- Root `tsconfig.json` is shared; package has its own that extends it
- CJS build outputs to `lib/`, ESM to `esm/`, both with declaration files
- Published files: `lib/` and `esm/` only

## Git Hooks & Conventions

- **pre-commit**: `tsc --noEmit` (full type check) + `lint-staged` (eslint --fix on staged .js/.ts/.tsx)
- **commit-msg**: commitlint with `@commitlint/config-conventional`
- Releases managed via Changesets (base branch: `master`)

## ESLint

Uses flat config (`eslint.config.js`) with `eslint-config-ted` and React support. Ignores output dirs (`esm/`, `lib/`, `.next/`).
