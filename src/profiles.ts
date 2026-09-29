import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, QuickConnectProfileProvider, TranslateService } from 'tabby-core'

import { ETProfile } from './api/interfaces'
import { ETProfileSettingsComponent } from './components/etProfileSettings.component'
import { ETTabComponent } from './components/etTab.component'
import { parseQuickConnectQuery } from './quickConnect'
import { DEFAULT_ET_PORT } from './protocol/constants'
import { resolveText, resolveUser } from './session/options'

@Injectable({ providedIn: 'root' })
export class ETProfilesService extends QuickConnectProfileProvider<ETProfile> {
    id = 'et'
    name = 'Eternal Terminal'
    settingsComponent = ETProfileSettingsComponent
    configDefaults = {
        options: {
            host: '',
            port: DEFAULT_ET_PORT,
            user: '',
            sshPort: 22,
            sshProfile: null,
            etterminalPath: null,
            serverFifo: null,
            jumpServerFifo: null,
            killOtherSessions: false,
            verbose: 0,
            bootstrapCaptureLimit: null,
            keepaliveInterval: 5,
            maxReconnectAttempts: 0,
            forwardedPorts: [],
            forwardAgent: false,
            // A map of whatever the user calls his variables, and not a
            // structure with members that are known. Tabby has to be told:
            // it would wrap a map that has defaults, show only the variables
            // that the defaults have, and show its own workings as well.
            environmentVariables: { __nonStructural: true },
            jumpHost: null,
            jumpPort: DEFAULT_ET_PORT,
            jumpSshProfile: null,
            jumpSshPort: 22,
            warnOnClose: null,
            scripts: [],
            input: { backspace: 'backspace' },
        },
        clearServiceMessagesOnConnect: true,
    }

    constructor (private translate: TranslateService) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<ETProfile>[]> {
        return [
            {
                id: 'et:template',
                type: 'et',
                name: this.translate.instant('Eternal Terminal connection'),
                icon: 'fas fa-infinity',
                options: { host: '', port: DEFAULT_ET_PORT, user: '' },
                isBuiltin: true,
                isTemplate: true,
                weight: -1,
            },
        ]
    }

    async getNewTabParameters (profile: ETProfile): Promise<NewTabParameters<ETTabComponent>> {
        return { type: ETTabComponent, inputs: { profile } }
    }

    getSuggestedName (profile: ETProfile): string {
        return this.intoQuickConnectString(profile) ?? ''
    }

    getDescription (profile: PartialProfile<ETProfile>): string {
        return hostOf(profile)
    }

    /**
     * Accepts "user@host", "user@host:2022", "user@[::1]:2022", and tolerates a
     * leading "et " or "et://" so users can paste a command line.
     */
    quickConnect (query: string): PartialProfile<ETProfile> {
        const target = parseQuickConnectQuery(query)
        return {
            name: query,
            type: 'et',
            options: { host: target.host, user: target.user, port: target.port },
        }
    }

    /**
     * Asked of every profile whenever the profile selector is opened, so it
     * has to answer for any profile, whatever that holds: what it throws, the
     * selector does not survive.
     */
    intoQuickConnectString (profile: ETProfile): string|null {
        let s = hostOf(profile)
        if (!s) {
            return null
        }
        if (s.includes(':') && !s.startsWith('[')) {
            s = `[${s}]`
        }
        const user = resolveUser(profile.options.user)
        if (user) {
            s = `${user}@${s}`
        }
        const port: unknown = profile.options.port
        if (typeof port === 'number' && Number.isInteger(port) && port !== DEFAULT_ET_PORT) {
            s = `${s}:${port}`
        }
        return s
    }
}

/** The host of a profile as text, which is not what a file has to hold. */
function hostOf (profile: PartialProfile<ETProfile>): string {
    const host: unknown = profile.options?.host
    return typeof host === 'number' ? String(host) : resolveText(host) ?? ''
}
