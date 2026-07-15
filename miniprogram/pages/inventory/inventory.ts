import {
  ensureSession,
  getErrorMessage,
  getInventory,
  getSelectedFamilyId,
  listFamilies,
} from '../../utils/api'
import {
  filterInventoryLocations,
  InventoryLocation,
  parseInventoryMarkdown,
} from '../../utils/inventory'

interface InputEvent {
  detail: {
    value: string
  }
}

Page({
  data: {
    loading: true,
    familyId: '',
    rootTitle: '家庭库存',
    versionLabel: '',
    keyword: '',
    allLocations: [] as InventoryLocation[],
    locations: [] as InventoryLocation[],
    itemCount: 0,
  },

  async onLoad() {
    await this.loadInventory()
  },

  async onPullDownRefresh() {
    await this.loadInventory()
    wx.stopPullDownRefresh()
  },

  async loadInventory() {
    this.setData({ loading: true })
    try {
      await ensureSession()
      const familyId = getSelectedFamilyId()
      if (!familyId) {
        this.setData({ familyId: '', loading: false })
        return
      }

      const [inventory, families] = await Promise.all([
        getInventory(familyId),
        listFamilies(),
      ])
      const parsed = parseInventoryMarkdown(inventory.content)
      const family = families.find((item) => item.id === familyId)
      const version = `${inventory.version}`
      this.setData({
        familyId,
        rootTitle: family?.name || parsed.rootTitle,
        versionLabel: version.length > 10 ? version.slice(0, 10) : version,
        allLocations: parsed.locations,
        locations: filterInventoryLocations(parsed.locations, this.data.keyword),
        itemCount: parsed.itemCount,
        loading: false,
      })
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  handleSearch(event: InputEvent) {
    const keyword = event.detail.value
    this.setData({
      keyword,
      locations: filterInventoryLocations(this.data.allLocations, keyword),
    })
  },

  clearSearch() {
    this.setData({
      keyword: '',
      locations: this.data.allLocations,
    })
  },

  openFamily() {
    wx.redirectTo({ url: '/pages/family/family' })
  },
})
