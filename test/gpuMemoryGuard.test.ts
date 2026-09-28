// Regression tests for the GPU memory guard.
//
// Tabby's stock terminal frontend (since upstream PR #11354, June 2026) keeps a
// full-size WebGL canvas alive for every hidden tab, never bounds the glyph
// atlas, never explicitly loses a WebGL context and lets the sixel image store
// grow to 128 MB per terminal. These tests pin the behaviour of the plugin-side
// guard that compensates for all four of those, using structural fakes of the
// exact host internals the guard touches.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
    DEFAULT_GPU_GUARD_OPTIONS,
    TerminalGPUGuard,
    applyImageStorageLimit,
    atlasBytes,
    checkAtlasBudget,
    collectWebGLContexts,
    releaseWebGL,
    restoreWebGL,
} from '../src/gpu/gpuMemoryGuard.ts'

const MiB = 1024 * 1024

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSubject<T> {
    private observers: ((value: T) => void)[] = []

    subscribe (next: (value: T) => void): { unsubscribe (): void } {
        this.observers.push(next)
        return {
            unsubscribe: () => {
                this.observers = this.observers.filter(o => o !== next)
            },
        }
    }

    next (value: T): void {
        for (const observer of [...this.observers]) {
            observer(value)
        }
    }

    get observerCount (): number {
        return this.observers.length
    }
}

class FakeScheduler {
    private timers = new Map<number, { at: number, fn: () => void }>()
    private now = 0
    private seq = 0

    setTimeout = (fn: () => void, ms: number): number => {
        const id = ++this.seq
        this.timers.set(id, { at: this.now + ms, fn })
        return id
    }

    clearTimeout = (id: unknown): void => {
        this.timers.delete(id as number)
    }

    advance (ms: number): void {
        this.now += ms
        let due = this.dueTimers()
        while (due.length) {
            for (const [id, timer] of due) {
                this.timers.delete(id)
                timer.fn()
            }
            due = this.dueTimers()
        }
    }

    get pending (): number {
        return this.timers.size
    }

    private dueTimers (): [number, { at: number, fn: () => void }][] {
        return [...this.timers.entries()]
            .filter(([, t]) => t.at <= this.now)
            .sort((a, b) => a[1].at - b[1].at)
    }
}

interface FakeCanvas {
    width: number
    height: number
    getContext (type: string): unknown
}

function makeCanvas (kind: 'webgl' | '2d', order: string[] = []): { canvas: FakeCanvas, loseCalls: { count: number } } {
    const loseCalls = { count: 0 }
    const gl = {
        getExtension: (name: string) => name === 'WEBGL_lose_context'
            ? { loseContext: () => { loseCalls.count++; order.push('lose') } }
            : null,
    }
    const canvas: FakeCanvas = {
        width: 1920,
        height: 1080,
        getContext: (type: string) => kind === 'webgl' && (type === 'webgl2' || type === 'webgl') ? gl : null,
    }
    return { canvas, loseCalls }
}

interface FakePage {
    canvas: { width: number, height: number }
}

function makeAddon (pages: FakePage[] = []) {
    return {
        disposed: 0,
        cleared: 0,
        dispose () { this.disposed++ },
        clearTextureAtlas () { this.cleared++ },
        _renderer: { _charAtlas: { pages } },
    }
}

function makeFrontend (opts: { pagesOnReattach?: FakePage[], withCanvases?: boolean } = {}) {
    const order: string[] = []
    const webglCanvas = makeCanvas('webgl', order)
    const linkCanvas = makeCanvas('2d', order)
    const canvases: FakeCanvas[] = opts.withCanvases === false ? [] : [webglCanvas.canvas, linkCanvas.canvas]
    const addon = makeAddon()
    const frontend = {
        enableWebGL: true,
        opened: true,
        element: { offsetParent: {} as unknown },
        xterm: {
            element: {
                querySelectorAll: (selector: string) => selector === 'canvas' ? canvases : [],
            },
            _addonManager: { _addons: [] as { instance: unknown }[] },
        },
        webGLAddon: addon as ReturnType<typeof makeAddon> | undefined,
        pendingRendererRecovery: false,
        rendererRecoveryAttempts: 0,
        attachCalls: 0,
        redrawCalls: 0,
        destroyCalls: 0,
        attachWebGLAddon () {
            this.attachCalls++
            this.webGLAddon = makeAddon(opts.pagesOnReattach ?? [])
        },
        redraw () {
            this.redrawCalls++
        },
        destroy () {
            this.destroyCalls++
            order.push('destroy')
            this.webGLAddon?.dispose()
            this.webGLAddon = undefined
        },
    }
    return { frontend, addon, webglCanvas, linkCanvas, canvases, order }
}

function makeGuard (frontend: any, options: Record<string, unknown> = {}) {
    const visibility = new FakeSubject<boolean>()
    const scheduler = new FakeScheduler()
    const guard = new TerminalGPUGuard(
        { frontend, visibility$: visibility },
        { hiddenReleaseDelayMs: 30_000, scheduler, ...options },
    )
    return { guard, visibility, scheduler }
}

// ---------------------------------------------------------------------------
// 1. Hidden tabs release their WebGL renderer and get it back when shown
// ---------------------------------------------------------------------------

describe('1. hidden tabs release their WebGL renderer and get it back when shown', () => {
    test('releases the addon and loses its GL context after the hidden delay', () => {
        const { frontend, addon, webglCanvas, linkCanvas, canvases } = makeFrontend()
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        assert.equal(addon.disposed, 0, 'must not release immediately')
        scheduler.advance(29_999)
        assert.equal(addon.disposed, 0, 'must wait for the whole delay')
        scheduler.advance(1)

        assert.equal(addon.disposed, 1, 'WebGL addon disposed once')
        assert.equal(frontend.webGLAddon, undefined, 'host no longer references the addon')
        assert.equal(webglCanvas.loseCalls.count, 1, 'WebGL context must be lost explicitly')
        assert.equal(linkCanvas.loseCalls.count, 0, '2D canvases have no GL context to lose')
        for (const canvas of canvases) {
            assert.equal(canvas.width, 0, 'canvas backing store released')
            assert.equal(canvas.height, 0, 'canvas backing store released')
        }
    })

    test('showing the tab again before the delay cancels the release', () => {
        const { frontend, addon } = makeFrontend()
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        scheduler.advance(10_000)
        visibility.next(true)
        scheduler.advance(60_000)

        assert.equal(addon.disposed, 0)
        assert.equal(frontend.attachCalls, 0, 'nothing to restore')
        assert.equal(frontend.rendererRecoveryAttempts, 0)
        assert.equal(scheduler.pending, 0, 'no timer left behind')
    })

    test('restores the renderer on show without spending the host recovery budget', () => {
        const { frontend } = makeFrontend()
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        scheduler.advance(30_000)
        assert.equal(frontend.webGLAddon, undefined)

        visibility.next(true)

        assert.equal(frontend.attachCalls, 1, 'addon re-attached exactly once')
        assert.ok(frontend.webGLAddon, 'host references the new addon')
        assert.equal(frontend.redrawCalls, 1, 'a full repaint follows the re-attach')
        assert.equal(frontend.rendererRecoveryAttempts, 0, 'planned re-attach is not a recovery attempt')
        assert.equal(frontend.pendingRendererRecovery, false)
    })

    test('does not attach twice when the host already recovered the renderer', () => {
        const { frontend } = makeFrontend()
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        scheduler.advance(30_000)

        // The host's own reactivate() ran first and re-attached through its
        // context-loss recovery path, which costs one of three attempts.
        frontend.attachWebGLAddon()
        frontend.rendererRecoveryAttempts = 1

        visibility.next(true)

        assert.equal(frontend.attachCalls, 1, 'guard must not stack a second addon')
        assert.equal(frontend.rendererRecoveryAttempts, 0, 'guard hands the budget back')
    })

    test('leaves a tab alone while a GPU context-loss recovery is pending', () => {
        const { frontend, addon } = makeFrontend()
        frontend.pendingRendererRecovery = true
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        scheduler.advance(30_000)

        assert.equal(addon.disposed, 0)
        assert.equal(frontend.webGLAddon, addon)
    })

    test('ignores frontends that are not using WebGL', () => {
        const { frontend } = makeFrontend()
        frontend.enableWebGL = false
        frontend.webGLAddon = undefined
        const { visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        scheduler.advance(30_000)
        visibility.next(true)

        assert.equal(frontend.attachCalls, 0)
        assert.equal(frontend.redrawCalls, 0)
    })

    test('dispose cancels a pending release and unsubscribes from visibility', () => {
        const { frontend, addon } = makeFrontend()
        const { guard, visibility, scheduler } = makeGuard(frontend)

        visibility.next(false)
        guard.dispose()
        scheduler.advance(60_000)

        assert.equal(addon.disposed, 0)
        assert.equal(scheduler.pending, 0)
        assert.equal(visibility.observerCount, 0)
    })

    test('default hidden delay matches the host INACTIVE_TAB_UNLOAD_DELAY of 30 s', () => {
        assert.equal(DEFAULT_GPU_GUARD_OPTIONS.hiddenReleaseDelayMs, 30_000)
    })

    test('releaseWebGL and restoreWebGL work as standalone helpers', () => {
        const { frontend, addon, webglCanvas } = makeFrontend()
        assert.equal(releaseWebGL(frontend), true)
        assert.equal(addon.disposed, 1)
        assert.equal(webglCanvas.loseCalls.count, 1)
        assert.equal(releaseWebGL(frontend), false, 'nothing left to release')

        assert.equal(restoreWebGL(frontend), true)
        assert.equal(frontend.attachCalls, 1)
        assert.equal(restoreWebGL(frontend), true, 'idempotent once attached')
        assert.equal(frontend.attachCalls, 1)
    })
})

// ---------------------------------------------------------------------------
// 2. The glyph atlas is kept under a budget
// ---------------------------------------------------------------------------

describe('2. the glyph atlas is kept under a budget', () => {
    const page = (size: number): FakePage => ({ canvas: { width: size, height: size } })

    test('atlasBytes sums the RGBA bytes of every atlas page', () => {
        const { frontend } = makeFrontend()
        frontend.webGLAddon = makeAddon([page(512), page(2048)])
        assert.equal(atlasBytes(frontend), 512 * 512 * 4 + 2048 * 2048 * 4)
    })

    test('clearTextureAtlas is called when the atlas exceeds the budget', () => {
        const { frontend } = makeFrontend()
        const addon = makeAddon([page(4096)])
        frontend.webGLAddon = addon
        assert.equal(checkAtlasBudget(frontend, 16 * MiB), true)
        assert.equal(addon.cleared, 1)
    })

    test('nothing is cleared while the atlas is within budget', () => {
        const { frontend } = makeFrontend()
        const addon = makeAddon([page(512), page(512)])
        frontend.webGLAddon = addon
        assert.equal(checkAtlasBudget(frontend, 16 * MiB), false)
        assert.equal(addon.cleared, 0)
    })

    test('missing renderer internals are tolerated', () => {
        const { frontend } = makeFrontend()
        frontend.webGLAddon = { dispose () { }, clearTextureAtlas () { } } as any
        assert.equal(atlasBytes(frontend), 0)
        assert.equal(checkAtlasBudget(frontend, 1), false)
        frontend.webGLAddon = undefined
        assert.equal(checkAtlasBudget(frontend, 1), false)
    })

    test('the guard checks the budget whenever a tab is shown', () => {
        const { frontend } = makeFrontend({ pagesOnReattach: [page(4096), page(4096)] })
        const { visibility, scheduler } = makeGuard(frontend, { atlasBudgetBytes: 48 * MiB })

        visibility.next(false)
        scheduler.advance(30_000)
        visibility.next(true)

        assert.equal(frontend.webGLAddon!.cleared, 1, 'oversized shared atlas cleared on show')
    })

    test('the guard exposes an on-demand budget check for periodic use', () => {
        const { frontend } = makeFrontend()
        const addon = makeAddon([page(8192)])
        frontend.webGLAddon = addon
        const { guard } = makeGuard(frontend, { atlasBudgetBytes: 48 * MiB })
        assert.equal(guard.checkAtlasBudget(), true)
        assert.equal(addon.cleared, 1)
    })
})

// ---------------------------------------------------------------------------
// 3. GL contexts are lost explicitly when a terminal is destroyed
// ---------------------------------------------------------------------------

describe('3. GL contexts are lost explicitly when a terminal is destroyed', () => {
    test('collectWebGLContexts only returns contexts of WebGL canvases', () => {
        const { canvases } = makeFrontend()
        const contexts = collectWebGLContexts(canvases)
        assert.equal(contexts.length, 1)
    })

    test('destroy() loses the WebGL context after the original destroy ran', () => {
        const { frontend, addon, webglCanvas, canvases, order } = makeFrontend()
        makeGuard(frontend)

        frontend.destroy()

        assert.equal(frontend.destroyCalls, 1, 'original destroy still runs')
        assert.equal(addon.disposed, 1)
        assert.equal(webglCanvas.loseCalls.count, 1, 'context lost instead of waiting for GC')
        assert.deepEqual(order, ['destroy', 'lose'], 'lose after the host tore the renderer down')
        for (const canvas of canvases) {
            assert.equal(canvas.width, 0)
            assert.equal(canvas.height, 0)
        }
    })

    test('destroy() only loses each context once even if called twice', () => {
        const { frontend, webglCanvas } = makeFrontend()
        makeGuard(frontend)
        frontend.destroy()
        frontend.destroy()
        assert.equal(webglCanvas.loseCalls.count, 1)
        assert.equal(frontend.destroyCalls, 2)
    })

    test('destroy() is safe without any canvases', () => {
        const { frontend } = makeFrontend({ withCanvases: false })
        makeGuard(frontend)
        assert.doesNotThrow(() => frontend.destroy())
        assert.equal(frontend.destroyCalls, 1)
    })

    test('disposing the guard restores the original destroy', () => {
        const { frontend, webglCanvas } = makeFrontend()
        const original = frontend.destroy
        const { guard } = makeGuard(frontend)
        assert.notEqual(frontend.destroy, original, 'guard wrapped destroy')
        guard.dispose()
        assert.equal(frontend.destroy, original)
        frontend.destroy()
        assert.equal(webglCanvas.loseCalls.count, 0)
    })
})

// ---------------------------------------------------------------------------
// 4. Sixel image storage is capped
// ---------------------------------------------------------------------------

describe('4. sixel image storage is capped', () => {
    function makeXterm (addons: unknown[]) {
        return { _addonManager: { _addons: addons.map(instance => ({ instance })) } }
    }

    test('lowers the image addon storage limit', () => {
        const imageAddon = { storageLimit: 128, storageUsage: 0 }
        const xterm = makeXterm([{ fit () { } }, imageAddon, null])
        assert.equal(applyImageStorageLimit(xterm, 32), true)
        assert.equal(imageAddon.storageLimit, 32)
    })

    test('does not raise a limit that is already lower', () => {
        const imageAddon = { storageLimit: 16, storageUsage: 0 }
        const xterm = makeXterm([imageAddon])
        assert.equal(applyImageStorageLimit(xterm, 32), false)
        assert.equal(imageAddon.storageLimit, 16)
    })

    test('returns false when the image addon is absent or internals changed', () => {
        assert.equal(applyImageStorageLimit(makeXterm([{ fit () { } }]), 32), false)
        assert.equal(applyImageStorageLimit({}, 32), false)
        assert.equal(applyImageStorageLimit(undefined, 32), false)
    })

    test('the guard applies the cap when it attaches to a terminal', () => {
        const { frontend } = makeFrontend()
        const imageAddon = { storageLimit: 128, storageUsage: 0 }
        frontend.xterm._addonManager._addons.push({ instance: imageAddon })
        makeGuard(frontend, { imageStorageLimitMB: 24 })
        assert.equal(imageAddon.storageLimit, 24)
    })

    test('default image cap is well below the addon default of 128 MB', () => {
        assert.ok(DEFAULT_GPU_GUARD_OPTIONS.imageStorageLimitMB < 128)
        assert.ok(DEFAULT_GPU_GUARD_OPTIONS.imageStorageLimitMB > 0)
    })
})
