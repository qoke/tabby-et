import { Component } from '@angular/core'
import { PlatformService } from 'tabby-core'

import { TABBY_SUPPORT_GUIDE_URL, TABBY_SUPPORT_PR_URL, TabbySupport, tabbySupport } from '../tabbySupport'

/**
 * Says, where Eternal Terminal is set up, that this Tabby cannot run it yet,
 * and how to get a Tabby that can. Shows nothing on a Tabby that can.
 * @hidden
 */
@Component({
    selector: 'et-tabby-support-notice',
    template: require('./etTabbySupportNotice.component.pug'),
})
export class ETTabbySupportNoticeComponent {
    support: TabbySupport = tabbySupport()

    constructor (private platform: PlatformService) { }

    openGuide (): void {
        void this.platform.openExternal(TABBY_SUPPORT_GUIDE_URL)
    }

    openPullRequest (): void {
        void this.platform.openExternal(TABBY_SUPPORT_PR_URL)
    }
}
