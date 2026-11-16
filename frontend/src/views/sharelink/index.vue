<template>
  <section class="page" data-module="sharelink">
    <header class="page-head">
      <div>
        <h2>分享管理管理</h2>
        <p class="page-desc">管理分析结果和看板的分享链接，配置访问密码和有效期。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记分享链接</button>
        <button class="btn primary" type="button" @click="migrateAll">按创建顺序迁移全部</button>
        <button class="btn" type="button" @click="exportArchive">导出快照归档</button>
        <button class="btn" type="button" @click="exportRows">导出分享管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <button class="link" type="button" @click="migrateOne(row)">
                {{ isFrozen(row) ? '重新迁移' : '迁移生成快照' }}
              </button>
              <button class="link" type="button" @click="openEntry(row)">打开旧入口</button>
              <button class="link" type="button" @click="openReview(row)">逐项复核</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无分享管理数据，可先登记分享链接</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 class="section-title">分享结果数据快照</h3>
    <p class="section-desc">
      迁移生成的结果快照按版本归档：旧完整版本在重新迁移时转为「已废弃」仅留存追溯，旧入口与数据导出只读取「完整」快照。
    </p>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in snapshotColumns" :key="column">{{ column }}</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="snapshot in snapshots" :key="String(snapshot.id)">
            <td v-for="column in snapshotColumns" :key="column">{{ snapshot[column] ?? '—' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="verifyOne(snapshot)">验证快照</button>
            </td>
          </tr>
          <tr v-if="!snapshots.length">
            <td :colspan="snapshotColumns.length + 1" class="empty-state">
              暂无快照，可对分享链接执行「迁移生成快照」或「按创建顺序迁移全部」
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条分享管理记录 · {{ snapshots.length }} 份结果快照</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="entryOpen" class="modal-mask" @click.self="closeEntry">
      <div class="modal-card">
        <div class="modal-head">
          <h3>旧入口 · {{ entryLink ? String(entryLink['链接URL']) : '' }}</h3>
          <button class="btn ghost" type="button" @click="closeEntry">关闭</button>
        </div>

        <template v-if="entryStage === 'blocked'">
          <p class="entry-note"><span class="badge blocked">不可访问</span> {{ entryMessage }}</p>
        </template>

        <template v-else-if="entryStage === 'password'">
          <p class="entry-note">{{ entryMessage }}</p>
          <div class="password-row">
            <input
              v-model="passwordInput"
              type="password"
              placeholder="请输入访问密码"
              @keyup.enter="submitPassword"
            />
            <button class="btn primary" type="button" @click="submitPassword">确认</button>
          </div>
        </template>

        <template v-else-if="entryStage === 'ready' && entryView">
          <p class="entry-note">
            <span class="badge" :class="entryView.mode === '冻结快照' ? 'frozen' : 'live'">
              {{ entryView.mode === '冻结快照' ? `冻结快照 ${entryView.snapshot?.['快照编号'] ?? ''}` : '实时页面内容 · 未迁移' }}
            </span>
            <template v-if="entryView.mode === '冻结快照'">
              当前查看的是迁移时冻结的分析数据（{{ entryView.snapshot?.['快照编号'] }}，冻结于
              {{ entryView.snapshot?.['冻结时间'] }}），来源链接 {{ entryView.link['链接编号'] }}。
            </template>
            <template v-else>
              当前查看的是页面实时内容，尚未迁移为冻结快照；迁移后旧链接将改为提供冻结数据。
            </template>
          </p>
          <p class="entry-meta">
            <span>内容类型：{{ entryView.contentType }}</span>
            <span>来源模块：{{ entryView.sourceModule }}</span>
            <span>来源编号：{{ entryView.sourceId }}</span>
            <span>来源链接：{{ entryView.link['链接编号'] }}</span>
            <span>有效期至：{{ entryView.link['有效期至'] || '不限' }}</span>
            <span>访问次数：{{ entryView.link['访问次数'] }}</span>
            <span>下载开关：{{ entryView.link['下载开关'] }}</span>
          </p>
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th v-for="column in entryDataColumns" :key="column">{{ column }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(dataRow, index) in entryView.rows" :key="index">
                  <td v-for="column in entryDataColumns" :key="column">{{ dataRow[column] ?? '—' }}</td>
                </tr>
                <tr v-if="!entryView.rows.length">
                  <td :colspan="Math.max(entryDataColumns.length, 1)" class="empty-state">
                    来源模块中未找到对应记录，展示链接自身内容：{{ entryView.title }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="modal-actions">
            <span v-if="entryMessage" class="info-text">{{ entryMessage }}</span>
            <button
              class="btn"
              type="button"
              :disabled="!canDownload"
              @click="downloadEntrySnapshot"
            >
              下载分析数据
            </button>
          </div>
          <p v-if="!canDownload" class="section-desc">
            {{ downloadHint }}
          </p>
        </template>
      </div>
    </div>

    <div v-if="reviewOpen" class="modal-mask" @click.self="reviewOpen = false">
      <div class="modal-card">
        <div class="modal-head">
          <h3>逐项复核 · {{ review?.link['链接编号'] }}</h3>
          <button class="btn ghost" type="button" @click="reviewOpen = false">关闭</button>
        </div>
        <p class="entry-note">
          复核结论：
          <span v-if="reviewAllPass" class="check-pass">全部一致，旧链接与最新完整快照逐项对齐</span>
          <span v-else class="check-fail">存在不一致项，请检查下方明细</span>
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>复核项</th>
              <th>结果</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="check in review?.checks ?? []" :key="check.item">
              <td>{{ check.item }}</td>
              <td :class="check.pass ? 'check-pass' : 'check-fail'">{{ check.pass ? '✓ 一致' : '✗ 不一致' }}</td>
              <td>{{ check.detail }}</td>
            </tr>
          </tbody>
        </table>
        <h3 class="section-title">版本历史（{{ review?.versions.length ?? 0 }} 份）</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>快照编号</th>
              <th>版本</th>
              <th>状态</th>
              <th>冻结时间</th>
              <th>迁移时访问次数</th>
              <th>下载次数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in review?.versions ?? []" :key="String(version.id)">
              <td>{{ version['快照编号'] }}</td>
              <td>v{{ version['版本'] }}</td>
              <td>{{ version.status }}</td>
              <td>{{ version['冻结时间'] }}</td>
              <td>{{ version['迁移时访问次数'] }}</td>
              <td>{{ version['下载次数'] }}</td>
            </tr>
            <tr v-if="!(review?.versions.length ?? 0)">
              <td colspan="6" class="empty-state">尚未迁移，没有版本记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="verifyOpen" class="modal-mask" @click.self="verifyOpen = false">
      <div class="modal-card">
        <div class="modal-head">
          <h3>验证快照 · {{ verifyTitle }}</h3>
          <button class="btn ghost" type="button" @click="verifyOpen = false">关闭</button>
        </div>
        <p class="entry-note">
          验证结论：
          <span v-if="verifyResult?.ok" class="check-pass">快照完整，可对外提供与导出</span>
          <span v-else class="check-fail">快照未通过验证</span>
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>检查项</th>
              <th>结果</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="check in verifyResult?.checks ?? []" :key="check.item">
              <td>{{ check.item }}</td>
              <td :class="check.pass ? 'check-pass' : 'check-fail'">{{ check.pass ? '✓ 通过' : '✗ 未通过' }}</td>
              <td>{{ check.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  DATA_MODE_FROZEN,
  downloadSnapshot,
  exportSnapshotArchive,
  listSnapshots,
  migrateAllShareLinks,
  migrateShareLink,
  openShareEntry,
  reviewLinkConsistency,
  verifySnapshot,
  type EntryView,
  type ReviewResult,
  type CheckItem,
} from '@/api/share-migration'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('sharelink')
const columns = meta.fields
const actions = ["生成链接", "标记失效"]
const statuses = ["草稿", "已生成", "已失效"]
const snapshotColumns = [
  '快照编号',
  '链接编号',
  '版本',
  '内容类型',
  '来源模块',
  '来源编号',
  '数据模式',
  '访问密码',
  '有效期至',
  '下载开关',
  '迁移时访问次数',
  '冻结时间',
  '下载次数',
  '最近下载时间',
]

const rows = ref<EntryRow[]>([])
const snapshots = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const entryOpen = ref(false)
const entryStage = ref<'blocked' | 'password' | 'ready'>('ready')
const entryMessage = ref('')
const entryLink = ref<EntryRow | null>(null)
const entryView = ref<EntryView | null>(null)
const passwordInput = ref('')

const reviewOpen = ref(false)
const review = ref<ReviewResult | null>(null)

const verifyOpen = ref(false)
const verifyTitle = ref('')
const verifyResult = ref<{ ok: boolean; checks: CheckItem[] } | null>(null)

const stats = computed(() => [
  { label: '分享链接总数', value: rows.value.length },
  { label: '有效链接数', value: rows.value.filter((row) => row.status === '已生成').length },
  {
    label: '今日访问量',
    value: rows.value.reduce((sum, row) => sum + (Number(row['访问次数']) || 0), 0),
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const entryDataColumns = computed(() => {
  const keys = new Set<string>()
  for (const row of entryView.value?.rows ?? []) {
    for (const key of Object.keys(row)) {
      if (!['id', 'status', 'pending', 'abnormal'].includes(key)) {
        keys.add(key)
      }
    }
  }
  return [...keys]
})

const canDownload = computed(
  () =>
    entryView.value?.mode === DATA_MODE_FROZEN &&
    String(entryView.value?.link['下载开关'] ?? '') === '开',
)

const downloadHint = computed(() => {
  if (!entryView.value) {
    return ''
  }
  if (String(entryView.value.link['下载开关'] ?? '') !== '开') {
    return '下载开关已关闭，按原规则不能导出。'
  }
  if (entryView.value.mode !== DATA_MODE_FROZEN) {
    return '尚未迁移，数据导出只读取完整快照，请先执行迁移。'
  }
  return ''
})

const reviewAllPass = computed(
  () => (review.value?.checks.length ?? 0) > 0 && (review.value?.checks ?? []).every((check) => check.pass),
)

function isFrozen(row: EntryRow): boolean {
  return String(row['数据模式'] ?? '') === DATA_MODE_FROZEN
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function exportArchive() {
  const { filename, content } = exportSnapshotArchive()
  downloadTextFile(filename, content)
  infoMessage.value = `已导出快照归档 ${filename}（含全部版本，含已废弃）`
}

function openCreate() {
  errorMessage.value = '分享链接登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function migrateOne(row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = migrateShareLink(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function migrateAll() {
  errorMessage.value = ''
  infoMessage.value = ''
  const results = migrateAllShareLinks()
  const failed = results.filter((result) => !result.ok)
  const succeeded = results.filter((result) => result.ok)
  if (failed.length > 0) {
    errorMessage.value = `按创建顺序迁移完成：成功 ${succeeded.length} 条，失败 ${failed.length} 条（${failed
      .map((result) => result.message)
      .join('；')}）。每条迁移独立提交，失败不影响已完成的快照`
  } else {
    infoMessage.value = `按创建顺序迁移完成：${succeeded
      .map((result) => `${result.linkCode} → v${result.version}`)
      .join('，')}`
  }
  reload()
}

function applyEntryResult(result: ReturnType<typeof openShareEntry>) {
  if (result.stage === 'blocked') {
    entryStage.value = 'blocked'
    entryMessage.value = result.message
    return
  }
  if (result.stage === 'password') {
    entryStage.value = 'password'
    entryMessage.value = result.message
    return
  }
  entryStage.value = 'ready'
  entryView.value = result.view
  entryMessage.value = ''
  reload()
}

function openEntry(row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  entryLink.value = row
  entryView.value = null
  passwordInput.value = ''
  entryOpen.value = true
  applyEntryResult(openShareEntry(Number(row.id)))
}

function submitPassword() {
  if (!entryLink.value) {
    return
  }
  applyEntryResult(openShareEntry(Number(entryLink.value.id), passwordInput.value))
}

function closeEntry() {
  entryOpen.value = false
  entryView.value = null
  entryLink.value = null
  entryMessage.value = ''
}

function downloadEntrySnapshot() {
  if (!entryLink.value) {
    return
  }
  const result = downloadSnapshot(Number(entryLink.value.id))
  if (!result.ok) {
    entryMessage.value = result.message
    return
  }
  downloadTextFile(result.filename as string, result.content as string)
  entryMessage.value = result.message
  reload()
}

function openReview(row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  review.value = reviewLinkConsistency(Number(row.id))
  reviewOpen.value = true
}

function verifyOne(snapshot: EntryRow) {
  verifyTitle.value = String(snapshot['快照编号'] ?? snapshot.id)
  verifyResult.value = verifySnapshot(Number(snapshot.id))
  verifyOpen.value = true
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    snapshots.value = [...listSnapshots()].sort((a, b) => Number(b.id) - Number(a.id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分享管理列表读取失败'
  }
}

onMounted(reload)
</script>
