// 起点: agent.status.changed で state が working 以外(done/waiting/blocked)に
// なった receivedAt = エージェントの応答が止まり、ユーザーの放置時間が始まった瞬間。
// そこから 50/55 分後に通知する（50分でキャッシュ切れ接近、55分で /compact を自動実行）。
// working に戻ったら(次の指示が来たら)放置終了とみなしタイマーをクリアする。
//
// 注意: 実機検証で、同じ放置期間中に done/waiting/blocked が receivedAt を
// 変えて数分おきに再送されることが確認された。タイマーが既に動いている間は
// 再送を無視し、最初に放置が始まった時刻を基準時刻として保持し続ける。
// これをやらないと再送のたびにタイマーがリセットされ、50分通知が永遠に
// 発火しなくなる。
//
// 55分(COMPACT_MINUTE)で orca CLI 経由で対象ワークツリーに /compact を自動送信する。
// compact実行(システムによる自動送信・人間による手動実行のどちらでも)は working
// への一時遷移を起こしうる。それだけだと「compact完了 = done」がまた新しい放置
// サイクルの起点として扱われてしまい、55分おきに永遠にcompactが走るループになる。
// これを防ぐため settled というフラグを導入する。settled中のワークツリーはユーザーが
// 本当に次の指示(working)を送るまで通知・compactを一切トリガーしない。
//
// settled化の経路は2つ:
//   1. システム自動compact: orca CLI経由の送信(execFile)が成功した時点で即settled化
//      する。完了(compact自体が実際に走ったか)までは確認しない。目的がレート枠対策
//      であり、万が一送信テキストが実行に至らなかった場合の実害は小さい一方、完了
//      確認のポーリングは無駄なコストになるため、送信成功をもって良しとする判断。
//      送信成功時は、まだ発火していない残りのタイマー(このケースでは無いが将来
//      NOTIFY_MINUTESが増えた場合に備え)も明示的にキャンセルする。
//   2. 人間による手動compact: agent.status.changed の done系イベントが来た瞬間に
//      orca terminal list の preview を見て、Claude Code がcompact完了時に出す
//      `recap:` という文言があれば「直前の working はcompact自身の処理だった」と
//      判定しsettled化する（wasJustCompacted）。イベントが発火しないケースでは
//      効かないが、その場合も次の放置サイクルでcompactが1回余分に走るだけに留まる。
// settled状態はstorageに永続化し、ワーカー再起動にも耐える。
//
// 注意(実機で発覚): `recap:` はcompact直後だけでなく、その後何ターン会話が続いても
// previewにずっと残り続けることがある。「recap:が含まれているか」だけで判定すると、
// 過去のcompactの残骸を「たった今のcompact」と誤検知し、以降ずっと放置通知が
// 発火しなくなる(false positiveでsettled化され続ける)。これを防ぐため、recapの
// 中身(要約本文)をハッシュ化して記憶し、「前回見たハッシュと違う」場合だけを
// 新規compactとみなす(wasJustCompacted / rememberCurrentRecap)。
//
// Orca のプラグインワーカーは「5分ホストとやり取りが無いと自動破棄・次回トリガーで
// 再フォーク」される (PLUGIN_WORKER_IDLE_REAP_MS = 5min, src/shared/plugins/
// plugin-host-protocol.ts)。setTimeout だけでは55分待てないため、カウントダウン中は
// 4分間隔で軽い host call を打ち lastActivityAt を更新し続けて破棄を防ぐ。
// ワーカー自体が再起動された場合に備え、開始時刻(とsettled状態)は storage にも
// 書いておき、activate() の先頭で未経過分のタイマー・settledを復元する。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// notifyMinutes/compactMinute/messagesはconfig.json（プラグイン直下、gitignore対象）で
// 上書きできる。無ければこのデフォルトを使う。詳細はREADMEの「設定のカスタマイズ」を参照。
const DEFAULT_CONFIG = {
  notifyMinutes: [50, 55],
  compactMinute: 55, // このタイミングで/compactを自動送信する
  messages: {
    warning: {
      title: '🟡 {label}: 放置{minutes}分',
      body: 'そろそろキャッシュ切れが近い、確認して'
    },
    compact: {
      title: '🔴 {label}: 放置{minutes}分',
      body: 'キャッシュ切れ確定ライン。これから/compactを自動実行するよ'
    }
  }
}

const MS_PER_MIN = 60 * 1000
const KEEPALIVE_INTERVAL_MS = 4 * MS_PER_MIN
const STORAGE_PREFIX = 'workingSince:'
const SETTLED_PREFIX = 'settled:'
const RECAP_HASH_PREFIX = 'recapHash:'
const COMPACT_RECAP_MARKER = 'recap:'

// config.jsonが無い/壊れている場合はデフォルトにフォールバックする。
function loadConfig(orca) {
  let userConfig = {}
  try {
    const configPath = fileURLToPath(new URL('./config.json', import.meta.url))
    userConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      orca.log(`config.json load failed, falling back to defaults: ${error.message}`)
    }
  }
  const notifyMinutes =
    Array.isArray(userConfig.notifyMinutes) && userConfig.notifyMinutes.length > 0
      ? [...userConfig.notifyMinutes].sort((a, b) => a - b)
      : DEFAULT_CONFIG.notifyMinutes
  const compactMinute =
    typeof userConfig.compactMinute === 'number' ? userConfig.compactMinute : notifyMinutes[notifyMinutes.length - 1]
  const messages = {
    warning: { ...DEFAULT_CONFIG.messages.warning, ...userConfig.messages?.warning },
    compact: { ...DEFAULT_CONFIG.messages.compact, ...userConfig.messages?.compact }
  }
  return { notifyMinutes, compactMinute, messages }
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

function storageKey(worktreeId) {
  return `${STORAGE_PREFIX}${worktreeId}`
}

function settledKey(worktreeId) {
  return `${SETTLED_PREFIX}${worktreeId}`
}

function recapHashKey(worktreeId) {
  return `${RECAP_HASH_PREFIX}${worktreeId}`
}

// previewの中の `recap:` 以降、次の罫線(────...)までを要約本文とみなして抽出する。
function extractRecapSection(preview) {
  const markerIndex = preview.indexOf(COMPACT_RECAP_MARKER)
  if (markerIndex === -1) return null
  const rest = preview.slice(markerIndex)
  const dividerIndex = rest.indexOf('─')
  return dividerIndex === -1 ? rest : rest.slice(0, dividerIndex)
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

// worktreeId は "<sessionId>::<path>" の形式。ラベル未登録の場合のフォールバックとして
// パス末尾のディレクトリ名を使う（worktree.created は新規作成時にしか発火しないため、
// 既存ワークツリーはラベルが登録されないことがある）。
function fallbackLabel(worktreeId) {
  const pathPart = worktreeId.includes('::') ? worktreeId.split('::').pop() : worktreeId
  const segments = pathPart.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : worktreeId
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function listTerminals() {
  const { stdout } = await execFileAsync('orca', ['terminal', 'list', '--json'])
  const parsed = JSON.parse(stdout)
  return parsed?.result?.terminals ?? []
}

async function findTerminal(worktreeId) {
  const terminals = await listTerminals()
  return terminals.find((terminal) => terminal.worktreeId === worktreeId) ?? null
}

async function triggerCompact(orca, worktreeId) {
  try {
    const terminal = await findTerminal(worktreeId)
    if (!terminal) {
      orca.log(`compact skipped: no terminal found for ${worktreeId}`)
      return false
    }
    await execFileAsync('orca', [
      'terminal',
      'send',
      '--terminal',
      terminal.handle,
      '--text',
      '/compact',
      '--enter'
    ])
    orca.log(`compact sent to ${worktreeId} (handle=${terminal.handle})`)
    return true
  } catch (error) {
    orca.log(`compact failed: ${error.message}`)
    return false
  }
}

// 現在画面に出ているrecapの中身を「既知」として記録する。settled解除の瞬間
// （working受信時）に呼ぶことで、システム自動compact直後にユーザーが指示を送った
// ケースでも、次のdoneイベントで同じrecapを誤って「新しい手動compact」と
// 判定しないようにする。
async function rememberCurrentRecap(orca, worktreeId) {
  try {
    const terminal = await findTerminal(worktreeId)
    const preview = terminal?.preview ?? ''
    const section = extractRecapSection(preview)
    if (!section) return
    await orca.host.call('storage.set', { key: recapHashKey(worktreeId), value: hashText(section) })
  } catch (error) {
    orca.log(`remember-recap failed: ${error.message}`)
  }
}

async function wasJustCompacted(orca, worktreeId) {
  try {
    const terminal = await findTerminal(worktreeId)
    const preview = terminal?.preview ?? ''
    const section = extractRecapSection(preview)
    if (!section) return false
    const hash = hashText(section)
    const key = recapHashKey(worktreeId)
    const { value: lastHash } = await orca.host.call('storage.get', { key })
    if (lastHash === hash) {
      // 既に見た(処理済みの)recap。古い残骸なので新規compactとはみなさない。
      return false
    }
    await orca.host.call('storage.set', { key, value: hash })
    return true
  } catch (error) {
    orca.log(`compact-detect failed: ${error.message}`)
    return false
  }
}

export default function activate(orca) {
  const config = loadConfig(orca)
  const worktreeLabels = new Map() // worktreeId -> branch/path
  const timersByWorktree = new Map() // worktreeId -> { timers: Timeout[] }
  const settledWorktrees = new Set()
  let keepaliveTimer = null

  function ensureKeepalive() {
    if (keepaliveTimer) return
    keepaliveTimer = setInterval(() => {
      orca.host.call('storage.get', { key: '__keepalive__' }).catch(() => {})
    }, KEEPALIVE_INTERVAL_MS)
  }

  function stopKeepaliveIfIdle() {
    if (timersByWorktree.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
  }

  function clearWorktreeTimers(worktreeId) {
    const entry = timersByWorktree.get(worktreeId)
    if (entry) {
      entry.timers.forEach(clearTimeout)
      timersByWorktree.delete(worktreeId)
    }
    stopKeepaliveIfIdle()
  }

  function markSettled(worktreeId) {
    settledWorktrees.add(worktreeId)
    orca.host.call('storage.set', { key: settledKey(worktreeId), value: true }).catch(() => {})
  }

  function clearSettled(worktreeId) {
    settledWorktrees.delete(worktreeId)
    orca.host.call('storage.delete', { key: settledKey(worktreeId) }).catch(() => {})
  }

  async function notify(worktreeId, minutes) {
    const label = worktreeLabels.get(worktreeId) || fallbackLabel(worktreeId)
    const isCompactMinute = minutes === config.compactMinute
    const template = isCompactMinute ? config.messages.compact : config.messages.warning
    const vars = { label, minutes }
    await orca.host.call('notifications.show', {
      title: renderTemplate(template.title, vars),
      body: renderTemplate(template.body, vars)
    })
    orca.log(`notified ${worktreeId} at ${minutes}min`)
    if (isCompactMinute) {
      const sent = await triggerCompact(orca, worktreeId)
      if (sent) {
        // 完了確認はしない。送信成功をもって「このサイクルはやることをやった」と
        // みなし、次にユーザーが本当に指示するまでこのワークツリーを止める。
        // まだ発火していない残りのタイマーがあれば併せてキャンセルする。
        markSettled(worktreeId)
        clearWorktreeTimers(worktreeId)
        orca.log(`settled (compact sent): ${worktreeId}`)
      }
    }
  }

  function scheduleForWorktree(worktreeId, workingSince) {
    clearWorktreeTimers(worktreeId)
    const now = Date.now()
    const pendingMinutes = config.notifyMinutes.filter(
      (minutes) => workingSince + minutes * MS_PER_MIN - now > 0
    )
    if (pendingMinutes.length === 0) {
      orca.host.call('storage.delete', { key: storageKey(worktreeId) }).catch(() => {})
      return
    }
    const entry = { timers: [] }
    timersByWorktree.set(worktreeId, entry)
    for (const minutes of pendingMinutes) {
      const delay = workingSince + minutes * MS_PER_MIN - Date.now()
      const timer = setTimeout(async () => {
        await notify(worktreeId, minutes)
        // notify内(compact送信成功時)でclearWorktreeTimersが既に呼ばれ、
        // このworktreeのエントリごと消えている場合はここで何もしない。
        if (!timersByWorktree.has(worktreeId)) return
        const idx = entry.timers.indexOf(timer)
        if (idx >= 0) entry.timers.splice(idx, 1)
        if (entry.timers.length === 0) {
          timersByWorktree.delete(worktreeId)
          orca.host.call('storage.delete', { key: storageKey(worktreeId) }).catch(() => {})
          stopKeepaliveIfIdle()
        }
      }, delay)
      entry.timers.push(timer)
    }
    ensureKeepalive()
    orca.host.call('storage.set', { key: storageKey(worktreeId), value: workingSince }).catch(() => {})
  }

  orca.events.on('worktree.created', (payload) => {
    worktreeLabels.set(payload.worktreeId, payload.branch || payload.path)
  })

  orca.events.on('worktree.removed', (payload) => {
    worktreeLabels.delete(payload.worktreeId)
    clearWorktreeTimers(payload.worktreeId)
    clearSettled(payload.worktreeId)
    orca.host.call('storage.delete', { key: storageKey(payload.worktreeId) }).catch(() => {})
    orca.host.call('storage.delete', { key: recapHashKey(payload.worktreeId) }).catch(() => {})
  })

  orca.events.on('agent.status.changed', (payload) => {
    const { worktreeId, state, receivedAt } = payload
    if (!worktreeId) return

    if (state === 'working') {
      // 次の指示が来た = 放置終了。settledも解除して次のサイクルに備える。
      clearWorktreeTimers(worktreeId)
      clearSettled(worktreeId)
      orca.host.call('storage.delete', { key: storageKey(worktreeId) }).catch(() => {})
      // 現在画面にあるrecap(もしあれば)を「既知」として記録しておく。
      // システム自動compact直後にユーザーが次の指示を送ったケースで、
      // その後のdoneイベントが同じrecapを新規compactと誤判定するのを防ぐ。
      rememberCurrentRecap(orca, worktreeId)
      return
    }

    if (settledWorktrees.has(worktreeId)) {
      // compact済みでsettled中。ユーザーの本当の指示(working)が来るまで何もしない。
      return
    }

    if (timersByWorktree.has(worktreeId)) {
      // 同じ放置期間中に done/waiting/blocked が receivedAt を変えて再送される
      // ことがあるため、既にタイマーが動いている間は再送を無視して基準時刻を
      // 保持する（そうしないと再送のたびにリセットされ通知が永遠に来ない）。
      return
    }

    // done/waiting/blocked = 放置カウント開始の候補。ただし直前の working が
    // 人間による手動compactの処理だった場合は、それ以上サイクルを回さずsettledにする。
    wasJustCompacted(orca, worktreeId).then((justCompacted) => {
      if (justCompacted) {
        markSettled(worktreeId)
        orca.log(`settled (compact detected via preview): ${worktreeId}`)
        return
      }
      scheduleForWorktree(worktreeId, receivedAt)
    })
  })

  // ワーカーが再起動された場合の復元。前回 working のまま記録されていた
  // ワークツリーについて、残っている通知だけ再スケジュールする。settled状態も復元する。
  orca.host
    .call('storage.keys', {})
    .then(async ({ keys }) => {
      for (const key of keys) {
        if (key.startsWith(SETTLED_PREFIX)) {
          settledWorktrees.add(key.slice(SETTLED_PREFIX.length))
          continue
        }
        if (!key.startsWith(STORAGE_PREFIX)) continue
        const worktreeId = key.slice(STORAGE_PREFIX.length)
        const { value } = await orca.host.call('storage.get', { key })
        if (typeof value === 'number') {
          scheduleForWorktree(worktreeId, value)
        }
      }
    })
    .catch((error) => orca.log(`restore failed: ${error.message}`))
}
