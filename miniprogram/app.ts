import { ensureSession } from './utils/api'

App<IAppOption>({
  globalData: {
    sessionReady: false,
  },
  onLaunch() {
    ensureSession()
      .then(() => {
        this.globalData.sessionReady = true
      })
      .catch(() => {
        this.globalData.sessionReady = false
      })
  },
})
