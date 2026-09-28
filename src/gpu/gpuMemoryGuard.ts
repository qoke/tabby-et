/**
 * GPU memory guard for Tabby terminal tabs.
 *
 * Stock Tabby (since upstream PR #11354, June 2026) keeps a full-resolution
 * WebGL canvas alive for every hidden terminal tab, never bounds the xterm.js
 * glyph atlas that every WebGL context mirrors, never explicitly loses a WebGL
 * context when a tab closes, and lets the sixel image store grow to 128 MB per
 * terminal. GPU memory therefore climbs with every tab opened and every new
 * glyph/colour combination seen, and rarely comes back down.
 *
 * This module compensates from the plugin side. It is deliberately free of
 * Angular, rxjs and tabby imports so it can be unit tested under plain Node.
 * It reaches into a few private members of Tabby's `XTermFrontend` and the
 * xterm.js WebGL addon; every access is feature-detected so a host that
 * renames them simply gets no guard instead of an exception.
 */

export interface GuardScheduler {
    setTimeout (fn: () => void, ms: number): unknown
    clearTimeout (handle: unknown): void
}

export interface GPUGuardOptions {
    /** How long a tab must stay hidden before its WebGL renderer is released. */
    hiddenReleaseDelayMs: number
    /** Clear the shared glyph atlas once its pages exceed this many bytes. */
    atlasBudgetBytes: number
    /** Cap for the sixel / inline image store of each terminal, in MB. */
    imageStorageLimitMB: number
    /** Timer source, injectable for tests. */
    scheduler: GuardScheduler
    /** Optional diagnostic sink. */
    log?: (message: string) => void
}

export const DEFAULT_GPU_GUARD_OPTIONS: Readonly<GPUGuardOptions> = {
    // Mirrors INACTIVE_TAB_UNLOAD_DELAY in tabby-terminal.
    hiddenReleaseDelayMs: 30 * 1000,
    atlasBudgetBytes: 48 * 1024 * 1024,
    imageStorageLimitMB: 32,
    scheduler: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
}

// ---------------------------------------------------------------------------
// Structural views of the host objects the guard touches
// ---------------------------------------------------------------------------

export interface CanvasLike {
    width: number
    height: number
    getContext (type: string): unknown
}

export interface WebGLContextLike {
    getExtension (name: string): { loseContext? (): void } | null | undefined
}

export interface AtlasPageLike {
    canvas: { width: number, height: number }
}

export interface WebGLAddonLike {
    dispose (): void
    clearTextureAtlas? (): void
    _renderer?: { _charAtlas?: { pages?: AtlasPageLike[] } }
}

export interface XtermLike {
    element?: { querySelectorAll (selector: string): ArrayLike<CanvasLike> } | null
    _addonManager?: { _addons?: { instance?: unknown }[] }
}

/** The private surface of tabby-terminal's XTermFrontend that the guard uses. */
export interface GuardableFrontend {
    xterm: XtermLike
    enableWebGL?: boolean
    opened?: boolean
    element?: { offsetParent: unknown } | null
    webGLAddon?: WebGLAddonLike
    pendingRendererRecovery?: boolean
    rendererRecoveryAttempts?: number
    attachWebGLAddon? (): void
    redraw? (): void
    destroy (): void
}

export interface VisibilitySource {
    subscribe (next: (visible: boolean) => void): { unsubscribe (): void }
}

export interface GuardedTerminal {
    frontend: GuardableFrontend
    visibility$: VisibilitySource
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Contexts that were already lost explicitly; losing twice is harmless but noisy. */
const lostContexts = new WeakSet<object>()

function toArray<T> (list: ArrayLike<T> | null | undefined): T[] {
    return list ? Array.prototype.slice.call(list) : []
}

export function collectCanvases (frontend: GuardableFrontend): CanvasLike[] {
    try {
        return toArray(frontend.xterm?.element?.querySelectorAll?.('canvas'))
    } catch {
        return []
    }
}

/**
 * Returns the WebGL contexts behind the given canvases. `getContext` hands
 * back the existing context for the type a canvas was created with and null
 * for any other type, so this never creates a context on xterm's 2D layers.
 */
export function collectWebGLContexts (canvases: ArrayLike<CanvasLike>): WebGLContextLike[] {
    const contexts: WebGLContextLike[] = []
    for (const canvas of toArray(canvases)) {
        try {
            const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLContextLike | null
            if (gl && typeof gl.getExtension === 'function') {
                contexts.push(gl)
            }
        } catch {
            // A detached or already-lost canvas; nothing to release.
        }
    }
    return contexts
}

/** Loses each context through WEBGL_lose_context. Returns how many were lost. */
export function loseContexts (contexts: WebGLContextLike[]): number {
    let lost = 0
    for (const gl of contexts) {
        if (lostContexts.has(gl)) {
            continue
        }
        try {
            const extension = gl.getExtension('WEBGL_lose_context')
            if (extension?.loseContext) {
                extension.loseContext()
                lostContexts.add(gl)
                lost++
            }
        } catch {
            // Context already gone.
        }
    }
    return lost
}

/** A 0x0 canvas has no GPU backing store; this frees it without waiting for GC. */
export function releaseCanvasBackingStores (canvases: ArrayLike<CanvasLike>): void {
    for (const canvas of toArray(canvases)) {
        try {
            canvas.width = 0
            canvas.height = 0
        } catch {
            // Read-only fake or detached node; ignore.
        }
    }
}

/**
 * Disposes the frontend's WebGL addon, then loses its GL context and drops
 * the backing stores of every renderer canvas. The addon's own dispose() only
 * removes the canvas from the DOM and leaves the context alive until garbage
 * collection, which GPU pressure never triggers.
 */
export function releaseWebGL (frontend: GuardableFrontend): boolean {
    const addon = frontend.webGLAddon
    if (!addon) {
        return false
    }
    const canvases = collectCanvases(frontend)
    const contexts = collectWebGLContexts(canvases)
    try {
        addon.dispose()
    } finally {
        frontend.webGLAddon = undefined
    }
    loseContexts(contexts)
    releaseCanvasBackingStores(canvases)
    return true
}

function isShown (frontend: GuardableFrontend): boolean {
    const element = frontend.element
    return !element || element.offsetParent !== null
}

/**
 * Re-attaches the WebGL addon after a planned release. This must not go
 * through the host's context-loss recovery, which has a three-attempt budget
 * before it permanently downgrades the tab to the DOM renderer, so the budget
 * counters are reset here whether the guard or the host did the re-attach.
 */
export function restoreWebGL (frontend: GuardableFrontend): boolean {
    if (frontend.enableWebGL === false) {
        return false
    }
    if (!frontend.webGLAddon) {
        if (typeof frontend.attachWebGLAddon !== 'function' || frontend.opened === false || !isShown(frontend)) {
            return false
        }
        try {
            frontend.attachWebGLAddon()
        } catch {
            return false
        }
        if (!frontend.webGLAddon) {
            return false
        }
        frontend.pendingRendererRecovery = false
        frontend.rendererRecoveryAttempts = 0
        try {
            frontend.redraw?.()
        } catch {
            // The host repaints on its own reactivate() as well.
        }
        return true
    }
    // The host's reactivate() got there first and re-attached through its
    // recovery path; hand the attempt it spent back.
    frontend.rendererRecoveryAttempts = 0
    return true
}

/** Bytes of RGBA pixel data across all pages of the renderer's glyph atlas. */
export function atlasBytes (frontend: GuardableFrontend): number {
    const pages = frontend.webGLAddon?._renderer?._charAtlas?.pages
    if (!Array.isArray(pages)) {
        return 0
    }
    let bytes = 0
    for (const page of pages) {
        const canvas = page?.canvas
        if (canvas) {
            bytes += (canvas.width | 0) * (canvas.height | 0) * 4
        }
    }
    return bytes
}

/**
 * Clears the glyph atlas when it has outgrown the budget. The atlas is shared
 * by every terminal with the same font and theme, and each of their GL
 * contexts uploads a full copy of every page plus mipmaps, so one oversized
 * atlas costs GPU memory once per open WebGL terminal.
 */
export function checkAtlasBudget (frontend: GuardableFrontend, budgetBytes: number): boolean {
    const addon = frontend.webGLAddon
    if (!addon || typeof addon.clearTextureAtlas !== 'function') {
        return false
    }
    if (atlasBytes(frontend) <= budgetBytes) {
        return false
    }
    try {
        addon.clearTextureAtlas()
    } catch {
        return false
    }
    return true
}

/**
 * Lowers the xterm image addon's storage cap. Tabby loads the addon with its
 * 128 MB default and keeps no reference to it, so it is located through the
 * addon manager by its `storageLimit` accessor. Never raises an existing cap.
 */
export function applyImageStorageLimit (xterm: Partial<XtermLike> | null | undefined, limitMB: number): boolean {
    const addons = xterm?._addonManager?._addons
    if (!Array.isArray(addons) || !(limitMB > 0)) {
        return false
    }
    for (const entry of addons) {
        const instance = entry?.instance as { storageLimit?: unknown } | null | undefined
        if (instance && typeof instance.storageLimit === 'number') {
            if (instance.storageLimit <= limitMB) {
                return false
            }
            try {
                instance.storageLimit = limitMB
            } catch {
                return false
            }
            return true
        }
    }
    return false
}

function withoutUndefined<T extends object> (source: T): Partial<T> {
    const result: Partial<T> = {}
    for (const key of Object.keys(source) as (keyof T)[]) {
        if (source[key] !== undefined) {
            result[key] = source[key]
        }
    }
    return result
}

// ---------------------------------------------------------------------------
// Per-terminal guard
// ---------------------------------------------------------------------------

/**
 * Attach one guard per terminal tab. It releases the WebGL renderer after the
 * tab has been hidden for `hiddenReleaseDelayMs`, restores it when the tab is
 * shown again, keeps the atlas within budget, caps the image store and loses
 * the GL context explicitly when the frontend is destroyed.
 */
export class TerminalGPUGuard {
    private readonly frontend: GuardableFrontend
    private readonly options: GPUGuardOptions
    private subscription?: { unsubscribe (): void }
    private pendingRelease?: unknown
    private releasedWhileHidden = false
    private originalDestroy?: () => void
    private wrappedDestroy?: () => void
    private destroyWasOwnProperty = false
    private disposed = false

    constructor (terminal: GuardedTerminal, options: Partial<GPUGuardOptions> = {}) {
        this.frontend = terminal.frontend
        this.options = { ...DEFAULT_GPU_GUARD_OPTIONS, ...withoutUndefined(options) }
        this.wrapDestroy()
        if (applyImageStorageLimit(this.frontend.xterm, this.options.imageStorageLimitMB)) {
            this.log(`image store capped at ${this.options.imageStorageLimitMB} MB`)
        }
        this.subscription = terminal.visibility$.subscribe(visible => this.onVisibility(visible))
    }

    /** True while the renderer has been released because the tab is hidden. */
    get released (): boolean {
        return this.releasedWhileHidden
    }

    onVisibility (visible: boolean): void {
        if (this.disposed) {
            return
        }
        this.cancelPendingRelease()
        if (visible) {
            this.restore()
            return
        }
        this.pendingRelease = this.options.scheduler.setTimeout(() => {
            this.pendingRelease = undefined
            this.release()
        }, this.options.hiddenReleaseDelayMs)
    }

    /** Release the WebGL renderer now. Skipped while a context-loss recovery is pending. */
    release (): boolean {
        const frontend = this.frontend
        if (this.disposed || frontend.pendingRendererRecovery || !frontend.webGLAddon) {
            return false
        }
        if (releaseWebGL(frontend)) {
            this.releasedWhileHidden = true
            this.log('released WebGL renderer of hidden terminal')
            return true
        }
        return false
    }

    /** Bring the renderer back if it was released, then check the atlas budget. */
    restore (): void {
        if (this.releasedWhileHidden) {
            this.releasedWhileHidden = false
            if (restoreWebGL(this.frontend)) {
                this.log('restored WebGL renderer of shown terminal')
            }
        }
        this.checkAtlasBudget()
    }

    checkAtlasBudget (): boolean {
        const cleared = checkAtlasBudget(this.frontend, this.options.atlasBudgetBytes)
        if (cleared) {
            this.log('glyph atlas exceeded its budget and was cleared')
        }
        return cleared
    }

    dispose (): void {
        if (this.disposed) {
            return
        }
        this.disposed = true
        this.cancelPendingRelease()
        this.subscription?.unsubscribe()
        this.subscription = undefined
        this.unwrapDestroy()
    }

    private cancelPendingRelease (): void {
        if (this.pendingRelease !== undefined) {
            this.options.scheduler.clearTimeout(this.pendingRelease)
            this.pendingRelease = undefined
        }
    }

    private log (message: string): void {
        try {
            this.options.log?.(message)
        } catch {
            // Logging must never break the guard.
        }
    }

    /**
     * Wraps frontend.destroy() so the WebGL context is lost right after the
     * host has torn the renderer down. The decorator's detach() runs too late
     * for this: by then the canvases are already out of the DOM.
     */
    private wrapDestroy (): void {
        const frontend = this.frontend
        const original = frontend.destroy
        if (typeof original !== 'function') {
            return
        }
        const wrapped = function (this: unknown, ...args: unknown[]): unknown {
            const canvases = collectCanvases(frontend)
            const contexts = collectWebGLContexts(canvases)
            try {
                return (original as (...a: unknown[]) => unknown).apply(this, args)
            } finally {
                loseContexts(contexts)
                releaseCanvasBackingStores(canvases)
            }
        }
        this.destroyWasOwnProperty = Object.prototype.hasOwnProperty.call(frontend, 'destroy')
        this.originalDestroy = original
        this.wrappedDestroy = wrapped
        frontend.destroy = wrapped
    }

    private unwrapDestroy (): void {
        const frontend = this.frontend
        if (!this.wrappedDestroy || frontend.destroy !== this.wrappedDestroy || !this.originalDestroy) {
            return
        }
        if (this.destroyWasOwnProperty) {
            frontend.destroy = this.originalDestroy
        } else {
            delete (frontend as Partial<GuardableFrontend>).destroy
        }
    }
}
