import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class ETConfigProvider extends ConfigProvider {
    defaults = {
        et: {
            warnOnClose: false,
            defaultEtterminalPath: null,
            debugProtocol: false,
            gpuMemoryGuard: {
                enabled: true,
                hiddenReleaseDelaySeconds: 30,
                atlasBudgetMB: 48,
                imageStorageLimitMB: 32,
            },
        },
        hotkeys: {
            'restart-et-session': [],
            'et-force-reconnect': [],
        },
    }

    platformDefaults = { }
}
