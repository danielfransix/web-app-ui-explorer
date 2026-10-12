import type { Scenario, Transition } from "../shared/types"

export type UiExplorerOptions = {
  /** Where every recipe starts. */
  startPath?: string
  /** Source folders to show, relative to the project root. */
  sources?: string[]
  /** Scenarios written by hand. They are shown next to the crawled ones and win on a matching id. */
  scenarios?: Scenario[]
  /** Extra connections between screens, for example "Continue". */
  transitions?: Transition[]
  /**
   * `merge` (default) shows crawled and hand-written scenarios together, `auto` only the crawled ones,
   * `manual` only the hand-written ones.
   */
  mode?: "merge" | "auto" | "manual"
  /** Folder for generated files, relative to the project root. */
  dir?: string
  /** URL path the explorer is served at. */
  route?: string
  /** Patterns for controls the crawler must never click. */
  deny?: string[]
  /** A Playwright storage-state file, for apps behind a login. */
  storageState?: string
  /** Most states a crawl records. */
  maxStates?: number
  /** Capture thumbnails when the explorer is opened and they are missing or out of date. On by default. */
  autoCapture?: boolean
  /**
   * Ship a read-only copy of the explorer inside production builds, under the explorer route: its page, the
   * scenarios, any captured thumbnails and the runtime the app loads. There is no server there, so exploring and
   * capturing are unavailable; the app and explorer must be on the same origin. Off by default.
   */
  static?: boolean
  /** Let the app send POST/PUT/DELETE requests while crawling and capturing. Off by default. */
  allowWrites?: boolean
}
