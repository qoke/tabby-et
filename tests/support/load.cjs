'use strict'

// Loads the plugin's TypeScript sources straight into Node with only Tabby's and
// Angular's runtime imports stubbed. Everything under test - the protocol codecs,
// the connection state machine, real net.Socket behaviour - runs unmodified.

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')

/** Enough of rxjs for the plugin: multicast, replay, and completion. */
class Subject {
    constructor () {
        this.observers = []
        this.closed = false
    }

    subscribe (next) {
        const observer = typeof next === 'function' ? { next } : next ?? {}
        if (this.closed) {
            observer.complete?.()
            return { unsubscribe () {} }
        }
        this.observers.push(observer)
        return {
            unsubscribe: () => {
                this.observers = this.observers.filter(x => x !== observer)
            },
        }
    }

    next (value) {
        if (this.closed) {
            return
        }
        for (const observer of [...this.observers]) {
            observer.next?.(value)
        }
    }

    complete () {
        if (this.closed) {
            return
        }
        this.closed = true
        const observers = this.observers
        this.observers = []
        for (const observer of observers) {
            observer.complete?.()
        }
    }
}

class ReplaySubject extends Subject {
    constructor (size = Infinity) {
        super()
        this.size = size
        this.buffer = []
    }

    subscribe (next) {
        const observer = typeof next === 'function' ? { next } : next ?? {}
        for (const value of this.buffer) {
            observer.next?.(value)
        }
        return super.subscribe(observer)
    }

    next (value) {
        if (this.closed) {
            return
        }
        this.buffer.push(value)
        while (this.buffer.length > this.size) {
            this.buffer.shift()
        }
        super.next(value)
    }
}

/** Mirrors tabby-terminal's BaseSession lifecycle, minus the middleware stack. */
class BaseSession {
    constructor (logger) {
        this.logger = logger
        this.open = false
        this.middleware = { stack: [], push (m) { this.stack.push(m) }, close () {} }
        this.output = new Subject()
        this.binaryOutput = new Subject()
        this.closed = new Subject()
        this.destroyed = new Subject()
        this.loginScriptProcessor = null
    }

    get output$ () { return this.output }
    get binaryOutput$ () { return this.binaryOutput }
    get closed$ () { return this.closed }
    get destroyed$ () { return this.destroyed }

    feedFromTerminal (data) {
        this.write(data)
    }

    emitOutput (data) {
        this.binaryOutput.next(data)
    }

    releaseInitialDataBuffer () {}

    setLoginScriptsOptions () {
        this.loginScriptProcessor = { executeUnconditionalScripts () {}, close () {} }
    }

    async destroy () {
        if (this.open) {
            this.open = false
            this.closed.next()
            this.destroyed.next()
            await this.gracefullyKillProcess()
        }
        this.middleware.close()
        this.closed.complete()
        this.destroyed.complete()
        this.output.complete()
        this.binaryOutput.complete()
    }
}

/** Mirrors the parts of Tabby's terminal tab that a connectable tab builds on. */
class BaseTerminalTabComponent {
    constructor (injector) {
        this.injector = injector
        this.session = null
        this.frontend = { scrollToBottom () {}, focus () {}, resetTerminalModes () {}, clear () {} }
        this.size = { columns: 80, rows: 24 }
        this.sessionChanged = new Subject()
        this.sessionHandlers = []
        this.spinnerActive = false
        this.recentInputs = ''
        this.hasFocus = true
        this.hotkeys = { hotkey$: new Subject() }
        this.errors = []
        this.infos = []
        this.notifications = {
            error: (...args) => this.errors.push(args),
            info: (...args) => this.infos.push(args),
            notice () {},
        }
        this.translate = { instant: (text, params) => text.replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '') }
        this.config = { store: { et: { warnOnClose: false } } }
        this.platform = { showMessageBox: async () => ({ response: 0 }) }
    }

    get sessionChanged$ () { return this.sessionChanged }

    ngOnInit () {}

    ngOnDestroy () {}

    subscribeUntilDestroyed (observable, handler) {
        observable.subscribe(handler)
    }

    setSession (session) {
        this.detachSessionHandlers()
        this.session = session
        if (session) {
            this.attachSessionHandler(session.closed$, () => this.onSessionClosed())
            this.attachSessionHandler(session.destroyed$, () => this.onSessionDestroyed())
        }
        this.sessionChanged.next(session)
    }

    attachSessionHandler (observable, handler) {
        this.sessionHandlers.push(observable.subscribe(handler))
    }

    detachSessionHandlers () {
        for (const subscription of this.sessionHandlers) {
            subscription.unsubscribe()
        }
        this.sessionHandlers = []
    }

    onSessionClosed () {}

    onSessionDestroyed () {
        this.setSession(null)
    }

    startSpinner () {
        this.spinnerActive = true
    }

    stopSpinner () {
        this.spinnerActive = false
    }

    isSessionExplicitlyTerminated () {
        return false
    }

    // Exactly what Tabby does: a session that is not open yet is left alone.
    async destroy () {
        this.frontend = undefined
        if (this.session?.open) {
            await this.session.destroy()
        }
    }
}
BaseTerminalTabComponent.template = ''
BaseTerminalTabComponent.styles = []
BaseTerminalTabComponent.animations = []

class ConnectableTerminalTabComponent extends BaseTerminalTabComponent {
    async initializeSession () {}

    async reconnect () {
        this.session?.destroy()
        await this.initializeSession()
    }
}

const stripAnsi = text => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const decorator = () => () => {}

/**
 * Create an isolated loader. `stubs` overrides or extends the default module
 * stubs, so a test can swap in its own SSHSession, say.
 */
function createLoader (stubs = {}) {
    const cache = new Map()
    const core = {
        ConfigService: class ConfigService {},
        LogService: class LogService {},
        ProfilesService: class ProfilesService {},
        QuickConnectProfileProvider: class QuickConnectProfileProvider {},
        ConfigProvider: class ConfigProvider {},
        HotkeyProvider: class HotkeyProvider {},
        TabRecoveryProvider: class TabRecoveryProvider {},
        Platform: { Web: 'Web' },
    }
    const modules = {
        'tabby-core': core,
        'tabby-ssh': {
            PortForwardType: { Local: 'Local', Remote: 'Remote', Dynamic: 'Dynamic' },
            SSHSession: class SSHSession {},
        },
        'tabby-terminal': {
            BaseSession,
            BaseTerminalTabComponent,
            ConnectableTerminalTabComponent,
            InputProcessor: class InputProcessor {},
            UTF8SplitterMiddleware: class UTF8SplitterMiddleware {},
        },
        rxjs: { Subject, ReplaySubject, Observable: class Observable {} },
        '@angular/core': {
            Component: () => target => target,
            Injectable: () => target => target,
            HostListener: decorator,
            HostBinding: decorator,
            Input: decorator,
            Output: decorator,
            ViewChild: decorator,
            EventEmitter: class EventEmitter extends Subject { emit (value) { this.next(value) } },
            Injector: class Injector {},
        },
        '@ng-bootstrap/ng-bootstrap': { NgbModal: class NgbModal {} },
        'ngx-toastr': { ToastrService: class ToastrService {} },
        '@biesbjerg/ngx-translate-extract-marker': { marker: text => text },
        'strip-ansi': { __esModule: true, default: stripAnsi },
        ...stubs,
    }

    function load (file) {
        file = path.resolve(root, file)
        if (cache.has(file)) {
            return cache.get(file).exports
        }
        const mod = { exports: {} }
        cache.set(file, mod)
        const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
                experimentalDecorators: true,
            },
            fileName: file,
        }).outputText
        const localRequire = name => {
            if (/\.(?:pug|scss)$/.test(name)) {
                return ''
            }
            if (name.startsWith('.')) {
                return load(path.resolve(path.dirname(file), `${name}.ts`))
            }
            if (Object.prototype.hasOwnProperty.call(modules, name)) {
                return modules[name]
            }
            return require(name)
        }
        new Function('require', 'module', 'exports', js)(localRequire, mod, mod.exports)
        return mod.exports
    }

    load.modules = modules
    return load
}

/** A quiet logger that still records what was said, for assertions. */
function createLogger () {
    const lines = []
    const log = level => (...args) => lines.push(`${level}: ${args.join(' ')}`)
    return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), log: log('log') }
}

/** Resolve once `predicate` holds; reject with `what` if it never does. */
async function waitFor (predicate, what = 'condition', timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        if (predicate()) {
            return
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}`)
        }
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

module.exports = { createLoader, createLogger, waitFor, Subject, ReplaySubject }
