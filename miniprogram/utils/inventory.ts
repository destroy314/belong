export interface InventoryLocation {
  key: string
  title: string
  level: number
  path: string[]
  pathText: string
  description: string
  items: string[]
}

export interface ParsedInventory {
  rootTitle: string
  locations: InventoryLocation[]
  itemCount: number
}

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/
const LIST_ITEM_PATTERN = /^\s*[-*+]\s+(.+?)\s*$/

export function parseInventoryMarkdown(markdown: string): ParsedInventory {
  const headings: string[] = []
  const locations: InventoryLocation[] = []
  let current: InventoryLocation | undefined
  let rootTitle = '家'
  let itemCount = 0

  markdown.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].trim()
      headings.splice(level - 1)
      headings[level - 1] = title

      if (level === 1) {
        rootTitle = title
      }

      current = {
        key: `${index}-${title}`,
        title,
        level,
        path: headings.filter(Boolean),
        pathText: headings.filter(Boolean).join(' / '),
        description: '',
        items: [],
      }
      locations.push(current)
      return
    }

    const item = line.match(LIST_ITEM_PATTERN)
    if (item && current) {
      current.items.push(item[1].trim())
      itemCount += 1
      return
    }

    const text = line.trim()
    if (text && current) {
      current.description = current.description
        ? `${current.description}\n${text}`
        : text
    }
  })

  return {
    rootTitle,
    locations: locations.filter((location) => location.level > 1),
    itemCount,
  }
}

export function filterInventoryLocations(
  locations: InventoryLocation[],
  keyword: string,
): InventoryLocation[] {
  const normalized = keyword.trim().toLocaleLowerCase()
  if (!normalized) {
    return locations
  }

  return locations.filter((location) => {
    const searchable = [
      location.pathText,
      location.description,
      ...location.items,
    ].join('\n').toLocaleLowerCase()
    return searchable.includes(normalized)
  })
}
