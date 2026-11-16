import { listRows, saveModules } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 分享结果数据快照存放在本地数据层的 sharesnapshot 键下，与分享链接同一份存储。
//
// 迁移的原子性约定：快照先在内存里构建完整并通过校验，然后与链接行一起经 saveModules
// 单次落盘——这是唯一的提交点。迁移中断只会发生在提交前（旧链接与旧快照完整）或提交后
// （新快照完整、旧版本转为已废弃留存追溯），不存在写了一半的中间态，因此「生成中」
// 状态永远不会落盘，对外读取与数据导出也只认状态为「完整」的快照。
export const SNAPSHOT_STORE_KEY = 'sharesnapshot'

export const DATA_MODE_LIVE = '实时内容'
export const DATA_MODE_FROZEN = '冻结快照'

export const SNAPSHOT_STATUS_COMPLETE = '完整'
export const SNAPSHOT_STATUS_SUPERSEDED = '已废弃'

// 分享内容类型 → 来源模块。快照里保留内容类型与来源编号，追溯分享内容来自哪里。
const CONTENT_SOURCES: Record<string, { key: string; name: string }> = {
  看板: { key: 'dashboardboard', name: '自助看板' },
  分析结果: { key: 'analysisnote', name: '分析笔记' },
  导出文件: { key: 'exporttask', name: '数据导出' },
}

export type SnapshotPayload = {
  title: string
  sourceModule: string
  sourceId: string
  rows: EntryRow[]
  note: string
}

export type MigrationResult = {
  ok: boolean
  message: string
  linkCode?: string
  version?: number
}

export type EntryView = {
  link: EntryRow
  mode: string
  contentType: string
  sourceModule: string
  sourceId: string
  title: string
  rows: EntryRow[]
  snapshot?: EntryRow
}

export type EntryOpenResult =
  | { stage: 'blocked'; message: string }
  | { stage: 'password'; message: string }
  | { stage: 'ready'; view: EntryView }

export type CheckItem = { item: string; pass: boolean; detail: string }

export type ReviewResult = {
  link: EntryRow
  snapshot?: EntryRow
  checks: CheckItem[]
  versions: EntryRow[]
}

function today(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function nowStamp(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return `${today()} ${hh}:${mi}:${ss}`
}

export function listSnapshots(): EntryRow[] {
  return listRows(SNAPSHOT_STORE_KEY)
}

export function snapshotsFor(linkCode: string): EntryRow[] {
  return listSnapshots()
    .filter((row) => String(row['链接编号']) === linkCode)
    .sort((a, b) => Number(b['版本']) - Number(a['版本']))
}

// 数据导出与旧入口只读取「完整」快照：被取代的旧版本仅留存追溯，不对外提供。
export function currentSnapshot(linkCode: string): EntryRow | undefined {
  return listSnapshots().find(
    (row) => String(row['链接编号']) === linkCode && row.status === SNAPSHOT_STATUS_COMPLETE,
  )
}

function parseContentType(link: EntryRow): string {
  const explicit = String(link['内容类型'] ?? '').trim()
  if (explicit && CONTENT_SOURCES[explicit]) {
    return explicit
  }
  const text = `${String(link['分享内容'] ?? '')} ${String(link['链接URL'] ?? '')}`
  for (const type of Object.keys(CONTENT_SOURCES)) {
    if (text.includes(type)) {
      return type
    }
  }
  return ''
}

function parseSourceId(link: EntryRow): string {
  const explicit = String(link['来源编号'] ?? '').trim()
  if (explicit) {
    return explicit
  }
  const text = `${String(link['分享内容'] ?? '')} ${String(link['链接URL'] ?? '')}`
  const match = text.match(/[A-Z]{4}-\d{4}/)
  return match ? match[0] : ''
}

// 冻结来源模块当前内容：看板 / 分析结果 / 导出文件按来源编号取行，生成快照数据。
function freezePayload(contentType: string, sourceId: string, title: string): SnapshotPayload {
  const source = CONTENT_SOURCES[contentType]
  const rows = listRows(source.key).filter((row) =>
    Object.values(row).some((value) => String(value) === sourceId),
  )
  const note =
    rows.length > 0
      ? `已冻结${source.name} ${sourceId} 的 ${rows.length} 条记录`
      : `来源${source.name}中未找到 ${sourceId}，冻结链接自身内容`
  return { title, sourceModule: source.name, sourceId, rows, note }
}

// 提交前的完整性校验：任何一项不满足都放弃提交，不写入任何数据。
function snapshotBuildError(snapshot: EntryRow): string {
  const required = ['快照编号', '链接编号', '链接URL', '内容类型', '来源编号', '分享内容', '数据模式', '下载开关']
  for (const field of required) {
    if (String(snapshot[field] ?? '').trim() === '') {
      return `必填字段「${field}」为空`
    }
  }
  const version = Number(snapshot['版本'])
  if (!Number.isInteger(version) || version < 1) {
    return `版本号「${String(snapshot['版本'])}」不合法`
  }
  try {
    const payload = JSON.parse(String(snapshot['快照数据'] ?? '')) as SnapshotPayload
    if (!Array.isArray(payload.rows) || typeof payload.title !== 'string') {
      return '快照数据结构不完整'
    }
  } catch {
    return '快照数据无法解析'
  }
  return ''
}

// 迁移单条分享链接：读取分享内容和链接URL，生成带版本的分享结果数据快照。
// 访问密码、有效期至、下载开关、访问次数与链接状态全部保持原样——失效规则不因迁移提前生效。
export function migrateShareLink(id: number): MigrationResult {
  const links = listRows('sharelink')
  const link = links.find((row) => Number(row.id) === id)
  if (!link) {
    return { ok: false, message: `没有找到编号为 ${id} 的分享链接` }
  }
  const linkCode = String(link['链接编号'] ?? '').trim()
  const title = String(link['分享内容'] ?? '').trim()
  const url = String(link['链接URL'] ?? '').trim()
  if (!linkCode || !title || !url) {
    return { ok: false, linkCode, message: `分享链接 ${linkCode || id} 的分享内容或链接URL为空，迁移取消，未写入任何数据` }
  }
  const contentType = parseContentType(link)
  const sourceId = parseSourceId(link)
  if (!contentType || !sourceId) {
    return { ok: false, linkCode, message: `分享链接 ${linkCode} 无法识别内容类型或来源编号，迁移取消，未写入任何数据` }
  }
  const snapshots = listSnapshots()
  // 重复处理同一链接只推进版本号：旧完整版本转为已废弃，不会复制出多份同一版本。
  const version =
    snapshots
      .filter((row) => String(row['链接编号']) === linkCode)
      .reduce((max, row) => Math.max(max, Number(row['版本']) || 0), 0) + 1
  const payload = freezePayload(contentType, sourceId, title)
  const snapshot: EntryRow = {
    id: snapshots.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: SNAPSHOT_STATUS_COMPLETE,
    pending: false,
    abnormal: false,
    快照编号: `SNAP-${linkCode}-v${version}`,
    链接编号: linkCode,
    链接URL: url,
    版本: version,
    内容类型: contentType,
    来源编号: sourceId,
    来源模块: CONTENT_SOURCES[contentType].name,
    分享内容: title,
    快照数据: JSON.stringify(payload),
    访问密码: String(link['访问密码'] ?? ''),
    有效期至: String(link['有效期至'] ?? ''),
    下载开关: String(link['下载开关'] ?? ''),
    迁移时访问次数: Number(link['访问次数']) || 0,
    数据模式: DATA_MODE_FROZEN,
    冻结时间: nowStamp(),
    下载次数: 0,
    最近下载时间: '',
  }
  const buildError = snapshotBuildError(snapshot)
  if (buildError) {
    return { ok: false, linkCode, message: `分享链接 ${linkCode} 快照校验未通过（${buildError}），迁移取消，未写入任何数据` }
  }
  // 单次原子提交：旧完整版本 → 已废弃，新快照落盘，链接行只更新快照引用。
  const nextSnapshots = [
    ...snapshots.map((row) =>
      String(row['链接编号']) === linkCode && row.status === SNAPSHOT_STATUS_COMPLETE
        ? { ...row, status: SNAPSHOT_STATUS_SUPERSEDED }
        : row,
    ),
    snapshot,
  ]
  const nextLinks = links.map((row) =>
    Number(row.id) === id ? { ...row, 快照版本: `v${version}`, 数据模式: DATA_MODE_FROZEN } : row,
  )
  saveModules({ sharelink: nextLinks, [SNAPSHOT_STORE_KEY]: nextSnapshots })
  return {
    ok: true,
    linkCode,
    version,
    message: `${linkCode} 已生成分享结果数据快照 v${version}（${CONTENT_SOURCES[contentType].name} · ${sourceId}），旧链接切换为冻结快照；访问密码、有效期、下载开关与访问次数保持原样`,
  }
}

// 存量链接按创建顺序逐条迁移；每条独立提交，中断时已迁移的完整、未迁移的原样。
export function migrateAllShareLinks(): MigrationResult[] {
  const ordered = [...listRows('sharelink')].sort((a, b) => {
    const byCreated = String(a['创建时间'] ?? '').localeCompare(String(b['创建时间'] ?? ''))
    return byCreated !== 0 ? byCreated : Number(a.id) - Number(b.id)
  })
  return ordered.map((link) => migrateShareLink(Number(link.id)))
}

// 打开旧入口：原规则（状态、有效期、访问密码）逐项校验通过后才放行，访问计数只增不清零。
export function openShareEntry(id: number, password?: string): EntryOpenResult {
  const links = listRows('sharelink')
  const link = links.find((row) => Number(row.id) === id)
  if (!link) {
    return { stage: 'blocked', message: `没有找到编号为 ${id} 的分享链接` }
  }
  const linkCode = String(link['链接编号'] ?? '')
  if (link.status === '已失效') {
    return { stage: 'blocked', message: `分享链接 ${linkCode} 已失效，无法访问` }
  }
  const expiry = String(link['有效期至'] ?? '').trim()
  if (expiry && expiry < today()) {
    return { stage: 'blocked', message: `分享链接 ${linkCode} 已于 ${expiry} 过期，无法访问` }
  }
  const required = String(link['访问密码'] ?? '').trim()
  if (required && password === undefined) {
    return { stage: 'password', message: '该分享需要访问密码' }
  }
  if (required && password !== required) {
    return { stage: 'password', message: '访问密码不正确，请重试' }
  }
  const nextLinks = links.map((row) =>
    Number(row.id) === id ? { ...row, 访问次数: (Number(row['访问次数']) || 0) + 1 } : row,
  )
  saveModules({ sharelink: nextLinks })
  const updated = nextLinks.find((row) => Number(row.id) === id) as EntryRow
  const snapshot = currentSnapshot(linkCode)
  if (snapshot) {
    const payload = JSON.parse(String(snapshot['快照数据'])) as SnapshotPayload
    return {
      stage: 'ready',
      view: {
        link: updated,
        mode: DATA_MODE_FROZEN,
        contentType: String(snapshot['内容类型']),
        sourceModule: String(snapshot['来源模块']),
        sourceId: String(snapshot['来源编号']),
        title: payload.title,
        rows: payload.rows,
        snapshot,
      },
    }
  }
  const contentType = parseContentType(link)
  const sourceId = parseSourceId(link)
  const source = CONTENT_SOURCES[contentType]
  const liveRows = source
    ? listRows(source.key).filter((row) => Object.values(row).some((value) => String(value) === sourceId))
    : []
  return {
    stage: 'ready',
    view: {
      link: updated,
      mode: DATA_MODE_LIVE,
      contentType: contentType || '未识别',
      sourceModule: source ? source.name : '未识别',
      sourceId: sourceId || '未识别',
      title: String(link['分享内容'] ?? ''),
      rows: liveRows,
    },
  }
}

// 从旧入口导出：数据导出只读取完整快照，下载记录归档到同一份快照上。
export function downloadSnapshot(id: number): { ok: boolean; message: string; filename?: string; content?: string } {
  const links = listRows('sharelink')
  const link = links.find((row) => Number(row.id) === id)
  if (!link) {
    return { ok: false, message: `没有找到编号为 ${id} 的分享链接` }
  }
  const linkCode = String(link['链接编号'] ?? '')
  if (String(link['下载开关'] ?? '') !== '开') {
    return { ok: false, message: `分享链接 ${linkCode} 的下载开关已关闭，不能导出` }
  }
  const snapshots = listSnapshots()
  const snapshot = snapshots.find(
    (row) => String(row['链接编号']) === linkCode && row.status === SNAPSHOT_STATUS_COMPLETE,
  )
  if (!snapshot) {
    return { ok: false, message: `分享链接 ${linkCode} 尚未迁移，没有完整快照；数据导出只读取完整快照，请先执行迁移` }
  }
  const payload = JSON.parse(String(snapshot['快照数据'])) as SnapshotPayload
  const metaLines = [
    ['快照编号', String(snapshot['快照编号'])],
    ['来源链接', linkCode],
    ['链接URL', String(snapshot['链接URL'])],
    ['数据模式', String(snapshot['数据模式'])],
    ['内容类型', String(snapshot['内容类型'])],
    ['来源模块', String(snapshot['来源模块'])],
    ['来源编号', String(snapshot['来源编号'])],
    ['冻结时间', String(snapshot['冻结时间'])],
  ].map((pair) => `# ${pair.join(',')}`)
  const dataKeys = [...new Set(payload.rows.flatMap((row) => Object.keys(row)))].filter(
    (key) => !['id', 'status', 'pending', 'abnormal'].includes(key),
  )
  const bodyLines = [dataKeys.join(',')]
  for (const row of payload.rows) {
    bodyLines.push(dataKeys.map((key) => String(row[key] ?? '')).join(','))
  }
  if (payload.rows.length === 0) {
    bodyLines.push(`# ${payload.note}`)
  }
  const content = `\uFEFF${[...metaLines, ...bodyLines].join('\n')}`
  // 下载归档写回同一份快照：次数 + 最近下载时间，与快照版本同步。
  const nextSnapshots = snapshots.map((row) =>
    Number(row.id) === Number(snapshot.id)
      ? { ...row, 下载次数: (Number(row['下载次数']) || 0) + 1, 最近下载时间: nowStamp() }
      : row,
  )
  saveModules({ [SNAPSHOT_STORE_KEY]: nextSnapshots })
  return {
    ok: true,
    message: `已按快照 ${String(snapshot['快照编号'])} 导出，下载记录已归档到该快照`,
    filename: `${String(snapshot['快照编号'])}.csv`,
    content,
  }
}

// 快照归档导出：所有版本（含已废弃）都在归档里，按版本可追溯。
export function exportSnapshotArchive(): { filename: string; content: string } {
  const header = [
    '快照编号',
    '链接编号',
    '版本',
    '内容类型',
    '来源模块',
    '来源编号',
    '数据模式',
    '状态',
    '访问密码',
    '有效期至',
    '下载开关',
    '迁移时访问次数',
    '冻结时间',
    '下载次数',
    '最近下载时间',
    '链接URL',
  ]
  const lines = [header.join(',')]
  for (const row of listSnapshots()) {
    lines.push(
      header
        .map((field) => (field === '状态' ? String(row.status ?? '') : String(row[field] ?? '')))
        .join(','),
    )
  }
  return { filename: '分享结果数据快照-归档.csv', content: `\uFEFF${lines.join('\n')}` }
}

// 验证单份快照：必填字段、版本、数据完整、状态、来源链接、版本唯一性逐项检查。
export function verifySnapshot(snapshotId: number): { ok: boolean; checks: CheckItem[] } {
  const snapshots = listSnapshots()
  const snapshot = snapshots.find((row) => Number(row.id) === snapshotId)
  if (!snapshot) {
    return { ok: false, checks: [{ item: '快照存在', pass: false, detail: `没有找到编号为 ${snapshotId} 的快照` }] }
  }
  const checks: CheckItem[] = []
  for (const field of ['快照编号', '链接编号', '链接URL', '内容类型', '来源编号', '分享内容', '数据模式', '下载开关']) {
    const value = String(snapshot[field] ?? '').trim()
    checks.push({ item: `必填字段·${field}`, pass: value !== '', detail: value !== '' ? value : '为空' })
  }
  const version = Number(snapshot['版本'])
  checks.push({
    item: '版本号',
    pass: Number.isInteger(version) && version >= 1,
    detail: `v${String(snapshot['版本'])}`,
  })
  let payloadOk = false
  let payloadDetail = ''
  try {
    const payload = JSON.parse(String(snapshot['快照数据'] ?? '')) as SnapshotPayload
    payloadOk = Array.isArray(payload.rows) && typeof payload.title === 'string'
    payloadDetail = payloadOk ? `数据行 ${payload.rows.length} 条 · ${payload.note}` : '快照数据结构不完整'
  } catch {
    payloadDetail = '快照数据无法解析'
  }
  checks.push({ item: '快照数据完整', pass: payloadOk, detail: payloadDetail })
  checks.push({
    item: '快照状态',
    pass: snapshot.status === SNAPSHOT_STATUS_COMPLETE,
    detail:
      snapshot.status === SNAPSHOT_STATUS_COMPLETE
        ? '完整，可对外提供'
        : `${String(snapshot.status)}（仅留存追溯，不对外提供）`,
  })
  const linkCode = String(snapshot['链接编号'] ?? '')
  const link = listRows('sharelink').find((row) => String(row['链接编号']) === linkCode)
  checks.push({
    item: '来源链接存在',
    pass: Boolean(link),
    detail: link ? `${linkCode} · 当前状态「${String(link.status)}」` : `未找到 ${linkCode}`,
  })
  const sameVersion = snapshots.filter(
    (row) => String(row['链接编号']) === linkCode && String(row['版本']) === String(snapshot['版本']),
  )
  checks.push({
    item: '版本唯一',
    pass: sameVersion.length === 1,
    detail:
      sameVersion.length === 1
        ? `${linkCode} v${String(snapshot['版本'])} 仅此一份`
        : `发现 ${sameVersion.length} 份同版本快照`,
  })
  return { ok: checks.every((check) => check.pass), checks }
}

// 逐项复核：旧链接的链接URL、访问密码、有效期、下载开关与最新完整快照逐项比对，
// 并确认访问计数未清零、链接快照引用与快照版本同步。
export function reviewLinkConsistency(id: number): ReviewResult | null {
  const link = listRows('sharelink').find((row) => Number(row.id) === id)
  if (!link) {
    return null
  }
  const linkCode = String(link['链接编号'] ?? '')
  const versions = snapshotsFor(linkCode)
  const snapshot = versions.find((row) => row.status === SNAPSHOT_STATUS_COMPLETE)
  const checks: CheckItem[] = []
  if (!snapshot) {
    checks.push({ item: '迁移状态', pass: false, detail: '尚未迁移，没有可比对的结果快照' })
    return { link, checks, versions }
  }
  for (const field of ['链接URL', '访问密码', '有效期至', '下载开关']) {
    const linkValue = String(link[field] ?? '')
    const snapshotValue = String(snapshot[field] ?? '')
    checks.push({
      item: field,
      pass: linkValue === snapshotValue,
      detail:
        linkValue === snapshotValue
          ? `链接与快照一致：${linkValue === '' ? '（空）' : linkValue}`
          : `链接为「${linkValue}」，快照 v${String(snapshot['版本'])} 冻结为「${snapshotValue}」`,
    })
  }
  const linkVisits = Number(link['访问次数']) || 0
  const frozenVisits = Number(snapshot['迁移时访问次数']) || 0
  checks.push({
    item: '访问次数',
    pass: linkVisits >= frozenVisits,
    detail: `链接当前 ${linkVisits} 次，快照 v${String(snapshot['版本'])} 冻结时 ${frozenVisits} 次，迁移未清零`,
  })
  const refOk =
    String(link['快照版本'] ?? '') === `v${String(snapshot['版本'])}` &&
    String(link['数据模式'] ?? '') === DATA_MODE_FROZEN
  checks.push({
    item: '快照引用同步',
    pass: refOk,
    detail: refOk
      ? `链接引用快照 v${String(snapshot['版本'])}，与归档一致`
      : `链接引用「${String(link['快照版本'] ?? '')}」，归档完整版本为 v${String(snapshot['版本'])}`,
  })
  return { link, snapshot, checks, versions }
}
