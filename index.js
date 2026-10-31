import { existsSync, openSync, readSync, closeSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 每次启动自动清理 Electron 网络目录里残留的登录 cookie 文件。
 *
 * 背景：桌面端每次启动都会在 %APPDATA%\@deepseek-ai\dsh-desktop\Network\ 下留下一份持久化的
 * cookie 数据库，长期不清理时这些 cookie 会被一起塞进每一次请求头，超过 16KB 后服务端直接回 431，
 * 界面就会永久停在 "Web authentication failed"。手动修法是彻底退出后删掉 Cookies 与
 * Cookies-journal 再打开；这个插件把这一步自动化。
 *
 * 安全约束（写在最前面，因为删错文件是不可逆的）：
 * - 只在 known 的 Electron 网络目录里动手：%APPDATA%\@deepseek-ai\<app>\Network\ 及其下的
 *   Partitions\<p>\Network\；匹配用的路径必须是自己拼出来的绝对路径。
 * - 只删固定名单里的文件名：Cookies、Cookies-journal、Trust Tokens、Trust Tokens-journal。
 * - 只删看起来是 cookie 数据库的文件：文件头必须是 SQLite、LevelDB 的 "Cookies" 段，或空文件；
 *   读不到或不像就跳过，绝不猜。
 * - 所有失败都吞掉并写进状态，插件永远不因为清理失败而让启动失败。
 */

export const name = 'dsh-cookie-sweep'

const BASE_PATH = '/dsh-cookie-sweep'
const COOKIE_FILES = ['Cookies', 'Cookies-journal', 'Trust Tokens', 'Trust Tokens-journal']
/** 正在运行的进程要过一会儿才放开文件句柄，最多重试这么久。 */
const RETRY_MS = 250
const RETRY_TOTAL_MS = 6_000
/** 删不掉之后隔多久再看一眼：运行中的应用通常这会儿已经把库重新建好了。 */
const RECHECK_MS = 1_500
const SQLITE_MAGIC = 'SQLite format 3\0'
const LEVELDB_PREFIXES = ['CURRENT\n', 'MANIFEST-', 'LOG\n', 'LOCK\n']
/** 登录态本身写在 .dsh 里，网络目录里这些只是缓存；删掉最多让人重新授权一次。 */
const PROTECTED_SEGMENTS = ['\\.dsh\\', '\\dsh-home\\']

const config = {
  enabled: true,
  onStartup: true,
  extraPaths: [],
  keepTrustTokens: true,
}

/**
 * 配置行。DSH 的配置加载器读的是 `~standard` 上的 validate，不是普通的 JSON Schema：
 * 只给 type/properties 的话启动时会在 reading 'validate' 上抛错，整个条目都不会激活。
 * 这里的 validate 从不抛错，读不懂的值就退回默认，避免一个手改过的配置把 app 启动拖垮。
 */
const CONFIG_SCHEMA = {
  type: 'object', // ui-copy-ignore
  properties: {
    enabled: { type: 'boolean', description: '总开关；关闭后启动时不清、设置页也不允许手动清理。' }, // ui-copy-ignore
    onStartup: { type: 'boolean', description: '每次启动时自动清理一次。' }, // ui-copy-ignore
    extraPaths: {
      type: 'array', // ui-copy-ignore
      items: { type: 'string' }, // ui-copy-ignore
      description: '额外的 Electron 网络目录（绝对路径），只在默认位置之外时填写。', // ui-copy-ignore
    },
    keepTrustTokens: { type: 'boolean', description: '保留 Trust Tokens 数据库，只清 Cookies。' }, // ui-copy-ignore
  },
  additionalProperties: false, // ui-copy-ignore
}

export const Config = {
  ...CONFIG_SCHEMA,
  meta: { default: {} }, // ui-copy-ignore
  toJSON() {
    return CONFIG_SCHEMA
  },
  '~standard': {
    version: 1, // ui-copy-ignore
    vendor: 'dsh-cookie-sweep', // ui-copy-ignore
    validate(value) {
      return { value: settingsOf(value) }
    },
  },
}

let memo = {
  lastAt: null,
  lastTrigger: null,
  files: [],
}

function nowIso() {
  return new Date().toISOString()
}

function oneLine(value, limit = 300) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function settingsOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const pick = (key, fallback) => {
    const value = source[key]
    return typeof value === typeof fallback ? value : fallback
  }
  const extra = Array.isArray(source.extraPaths)
    ? source.extraPaths.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  return {
    enabled: pick('enabled', config.enabled),
    onStartup: pick('onStartup', config.onStartup),
    keepTrustTokens: pick('keepTrustTokens', config.keepTrustTokens),
    extraPaths: extra,
  }
}

/** Electron 的网络目录：<root>\Network 或 <root>\Partitions\<名>\Network。 */
function networkRoots(settings) {
  const found = new Map()
  const roots = []
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    const vendor = join(appData, '@deepseek-ai')
    roots.push(vendor)
    const parent = join(appData, 'deepseek-ai')
    roots.push(parent)
  }
  roots.push(...settings.extraPaths)
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const base = join(root, entry.name)
        found.set(join(base, 'Network').toLowerCase(), join(base, 'Network'))
        const partitions = join(base, 'Partitions')
        try {
          if (!existsSync(partitions)) continue
          for (const partition of readdirSync(partitions, { withFileTypes: true })) {
            if (!partition.isDirectory()) continue
            // 一次性会话（Partitions\temp-*）本来就不该有持久 cookie，动了只会打乱正在登录的流程。
            if (partition.name.startsWith('temp-')) continue
            const path = join(partitions, partition.name, 'Network')
            found.set(path.toLowerCase(), path)
          }
        } catch {
          /* 分区目录读不到就跳过，不影响主目录 */
        }
      }
    } catch {
      /* 目录不存在或不可读：不重要，换下一个候选 */
    }
  }
  for (const candidate of settings.extraPaths) {
    // 显式书写时把 \Network 也接受，省得用户自己揣摩格式。
    const trimmed = candidate.replace(/[\\/]+$/u, '')
    if (/[\\/]Network$/iu.test(trimmed)) found.set(trimmed.toLowerCase(), trimmed)
    else found.set(join(trimmed, 'Network').toLowerCase(), join(trimmed, 'Network'))
  }
  return [...found.values()]
}

function isProtected(path) {
  const lower = `\\${String(path).toLowerCase()}`
  return PROTECTED_SEGMENTS.some((segment) => lower.includes(segment))
}

/** 只读地看一眼这个文件像不像 cookie 数据库；不锁定文件，不改内容。 */
function classify(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { kind: 'skip', reason: '不是普通文件' }
    if (stat.size === 0) return { kind: 'empty', size: 0 }
    const size = Math.min(200, stat.size)
    const buffer = Buffer.alloc(size)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    const head = buffer.toString('utf8')
    if (head.startsWith(SQLITE_MAGIC)) return { kind: 'cookie', form: 'sqlite', size: stat.size }
    if (LEVELDB_PREFIXES.some((prefix) => head.startsWith(prefix))) {
      return { kind: 'cookie', form: 'leveldb', size: stat.size, keyBytes: countKeyBytes(path, stat.size) }
    }
    return { kind: 'skip', reason: '既不是 SQLite 也不是 LevelDB 的 cookie 文件', size: stat.size }
  } catch (error) {
    // 正被运行中的应用独占：这正是需要清理的场景，交给删除去重试。
    const code = String(error?.code ?? '')
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { kind: 'locked' }
    return { kind: 'skip', reason: oneLine(error?.message ?? error) }
  }
}

/**
 * Chrome 的 cookie 库会被反复整理，重复的键会以 "键"、"\x01键" 的分层形式共存；统计含 0x01
 * 或 0x00 前缀的键数量，是本地能给出的最接近"重复 cookie"的证据。
 */
function countKeyBytes(path, size) {
  try {
    const limit = Math.min(size, 4 * 1024 * 1024)
    const buffer = Buffer.alloc(limit)
    const fd = openSync(path, 'r')
    try {
      let read = 0
      while (read < limit) {
        const got = readSync(fd, buffer, read, limit - read, read)
        if (got <= 0) break
        read += got
      }
      let total = 0
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 0x01 || buffer[index] === 0x00) total += 1
      }
      return total
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sweep(trigger) {
  const settings = settingsOf(config)
  const startedAt = nowIso()
  const files = []
  const wanted = settings.keepTrustTokens ? ['Cookies', 'Cookies-journal'] : COOKIE_FILES
  for (const root of networkRoots(settings)) {
    for (const fileName of wanted) {
      const path = join(root, fileName)
      if (isProtected(path)) continue
      const record = { path, name: fileName, at: startedAt }
      if (!existsSync(path)) {
        files.push({ ...record, state: 'absent', size: 0 })
        continue
      }
      // 先看大小再谈内容：0 字节的文件无从判断身份，单靠"在名单里"不足以成为删除理由。
      try {
        record.size = statSync(path).size
      } catch {
        record.size = 0
      }
      const look = classify(path)
      if (look.form) record.form = look.form
      if (typeof look.keyBytes === 'number') record.strangeKeys = look.keyBytes
      if (record.size === 0) {
        // 空文件：可能只是在启动时刚被 Electron 建出来、还没写入的占位；也可能是残留。
        // 删掉它没有损失，但要说清楚这是"看大小判断"，而不是看过内容。
        record.form = 'empty'
      } else if (look.kind === 'skip') {
        files.push({ ...record, state: 'skipped', detail: look.reason })
        continue
      }
      // 删除失败不直接写进总结：见下面的"复核"，运行中的应用可能在清理之后再建一遍。
      const deadline = Date.now() + RETRY_TOTAL_MS
      let lastError = null
      for (;;) {
        try {
          unlinkSync(path)
          lastError = null
          break
        } catch (error) {
          lastError = error
          const code = String(error?.code ?? '')
          if (code === 'ENOENT') {
            lastError = null
            break
          }
          if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break
          if (Date.now() >= deadline) break
          await sleep(RETRY_MS)
        }
      }
      if (lastError === null) {
        files.push({ ...record, state: 'deleted' })
        continue
      }
      const code = String(lastError?.code ?? '')
      files.push({
        ...record,
        state: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'busy' : 'failed',
        detail: oneLine(lastError?.message ?? lastError),
        code: code || undefined,
        retriedUntil: new Date(deadline).toISOString(),
      })
    }
  }
  // 复核：运行中的应用会在清理之后把 cookie 库再建一遍，原来那份被占用时的报错于是成了假警报。
  // 这次复核只是读一眼目录，不删任何东西；删不掉就是删不掉，能删掉的话状态也要改成符合事实的那种。
  await sleep(RECHECK_MS)
  for (const record of files) {
    if (record.state !== 'busy' && record.state !== 'failed') continue
    if (!existsSync(record.path)) {
      record.state = 'recreated-then-gone'
      record.detail = null
      continue
    }
    const original = record.size ?? 0
    let current = 0
    try {
      current = statSync(record.path).size
    } catch {
      current = 0
    }
    if (current !== original) {
      record.state = 'recreated'
      record.detail = `重新建出了 ${current} 字节，此后由下次启动清理`
      record.size = current
    }
  }
  const summary = {
    at: startedAt,
    trigger,
    files,
    deleted: files.filter((item) => item.state === 'deleted').length,
    busy: files.filter((item) => item.state === 'busy').length,
    absent: files.filter((item) => item.state === 'absent').length,
    skipped: files.filter((item) => item.state === 'skipped').length,
    failed: files.filter((item) => item.state === 'failed').length,
    recreated: files.filter((item) => item.state === 'recreated' || item.state === 'recreated-then-gone').length,
    recheckedAt: new Date(Date.now()).toISOString(),
  }
  memo = { lastAt: summary.at, lastTrigger: trigger, files: summary.files, summary }
  return summary
}

function status() {
  const settings = settingsOf(config)
  return {
    enabled: settings.enabled,
    onStartup: settings.onStartup,
    keepTrustTokens: settings.keepTrustTokens,
    extraPaths: settings.extraPaths,
    roots: networkRoots(settings),
    lastAt: memo.lastAt,
    lastTrigger: memo.lastTrigger,
    files: memo.files,
    summary: memo.summary ?? null,
    home: homedir(),
  }
}

function sendJson(res, code, payload) {
  try {
    const body = JSON.stringify(payload)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    try {
      res.statusCode = 500
      res.end()
    } catch {
      /* 连接已经没了 */
    }
  }
}

/**
 * 把路由挂到本地 web 服务器上。任何一步失败都只是少一个设置页，不影响插件与 app 启动。
 */
function serve(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') return () => {}
  const disposers = []
  const routes = [
    [
      `${BASE_PATH}/status`,
      (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { status: 'method' })
        sendJson(res, 200, status())
      },
    ],
    [
      `${BASE_PATH}/clean`,
      (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
        const settings = settingsOf(config)
        if (!settings.enabled) return sendJson(res, 200, { status: 'off', ...status() })
        sweep('manual')
          .then((summary) => {
            sendJson(res, 200, { status: 'done', summary, ...status() })
          })
          .catch((error) => {
            sendJson(res, 200, { status: 'failed', detail: oneLine(error?.message ?? error), ...status() })
          })
      },
    ],
  ]
  for (const [path, handler] of routes) {
    try {
      const guarded = (req, res) => {
        try {
          handler(req, res)
        } catch (error) {
          if (res?.headersSent !== true) sendJson(res, 500, { status: 'error', detail: oneLine(error?.message ?? error) })
        }
      }
      const dispose = server.register({ kind: 'exact', path, handler: guarded })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch {
      /* 这条路由没挂上：设置页会显示"状态读取失败"，其余功能不受影响 */
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已经关掉了 */
      }
    }
  }
}

export function apply(ctx, rawConfig) {
  Object.assign(config, settingsOf({ ...config, ...(rawConfig ?? {}) }))
  const settings = settingsOf(config)
  if (settings.enabled && settings.onStartup) {
    // 启动清理是后台行为：没人等它，失败也只是记在状态里给设置页看。
    sweep('startup').catch(() => {})
  }
  const dispose = serve(ctx)
  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('dispose', () => {
        try {
          dispose()
        } catch {
          /* 已关闭 */
        }
      })
    } catch {
      /* 没有 dispose 钩子：路由随插件卸载自然失效 */
    }
  }
}
