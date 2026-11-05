/// <reference types="vite/client" />

import type { StudioApi } from '../contracts/api'

declare global {
  interface Window { storyweave?: StudioApi }
}

export {}
