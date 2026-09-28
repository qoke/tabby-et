import { Injectable } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator, XTermFrontend } from 'tabby-terminal'

import { GuardableFrontend, TerminalGPUGuard } from './gpuMemoryGuard'

/** How often the shared glyph atlas of every guarded terminal is measured. */
const ATLAS_CHECK_INTERVAL = 60 * 1000

export interface GPUMemoryGuardConfig {
    enabled: boolean
    hiddenReleaseDelaySeconds: number
    atlasBudgetMB: number
    imageStorageLimitMB: number
}

/**
 * Attaches a TerminalGPUGuard to every terminal tab. Applies to all terminal
 * tabs, not only Eternal Terminal ones, because the GPU growth it compensates
 * for is in the host's shared terminal frontend.
 *
 * @hidden
 */
@Injectable()
export class GPUMemoryGuardDecorator extends TerminalDecorator {
    private guards = new Map<BaseTerminalTabComponent<any>, TerminalGPUGuard>()
    private atlasTimer?: ReturnType<typeof setInterval>
    private logger: Logger

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        super()
        this.logger = log.create('et-gpu-guard')
    }

    attach (terminal: BaseTerminalTabComponent<any>): void {
        const settings: Partial<GPUMemoryGuardConfig> | undefined = this.config.store.et?.gpuMemoryGuard
        if (!settings?.enabled) {
            return
        }
        const frontend = terminal.frontend
        if (!(frontend instanceof XTermFrontend) || this.guards.has(terminal)) {
            return
        }
        const guard = new TerminalGPUGuard(
            {
                frontend: frontend as unknown as GuardableFrontend,
                visibility$: terminal.visibility$,
            },
            {
                hiddenReleaseDelayMs: positive(settings.hiddenReleaseDelaySeconds, 30) * 1000,
                atlasBudgetBytes: positive(settings.atlasBudgetMB, 48) * 1024 * 1024,
                imageStorageLimitMB: positive(settings.imageStorageLimitMB, 32),
                log: message => this.logger.debug(message),
            },
        )
        this.guards.set(terminal, guard)
        this.ensureAtlasTimer()
    }

    detach (terminal: BaseTerminalTabComponent<any>): void {
        this.guards.get(terminal)?.dispose()
        this.guards.delete(terminal)
        if (!this.guards.size) {
            this.stopAtlasTimer()
        }
        super.detach(terminal)
    }

    private ensureAtlasTimer (): void {
        if (this.atlasTimer) {
            return
        }
        this.atlasTimer = setInterval(() => {
            for (const guard of this.guards.values()) {
                guard.checkAtlasBudget()
            }
        }, ATLAS_CHECK_INTERVAL)
    }

    private stopAtlasTimer (): void {
        if (this.atlasTimer) {
            clearInterval(this.atlasTimer)
            this.atlasTimer = undefined
        }
    }
}

function positive (value: unknown, fallback: number): number {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
}
