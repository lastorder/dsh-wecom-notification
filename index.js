/**
 * dsh-wecom-notification — Host half.
 *
 * The instant DSH stops and waits for a human — a permission approval, a
 * structured question, the end of a turn, a blocked goal, an error — push one
 * markdown message to a WeCom (企业微信) group robot.
 *
 * The only setting is `url`. It is `volatile`, so the Plugins page (see
 * `client.js`) edits it live without remounting this plugin.
 */

import { basename } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-wecom-notification'
export const inject = []

export const Config = Schema.object({
  url: Schema.string().description('企业微信群机器人 Webhook 地址').volatile(),
})

/** Every message string, in the two languages DSH itself ships. */
const TEXT = {
  zh: {
    titles: { approval: '需要授权', question: '等待你的回答', idle: '任务已完成，等待下一步', 'goal-blocked': '目标被阻塞', error: '执行出错' },
    approval: (tool) => `需要授权执行 ${tool}`,
    unknownTool: '未知工具',
    options: '可选项：',
    moreQuestions: (header, count) => `${header}（还有 ${count} 个问题待回答）`,
    idle: '任务已结束，等待你的下一步指示',
    goalBlocked: '目标被阻塞，需要你介入',
    error: '执行出错，需要你确认',
  },
  en: {
    titles: { approval: 'Permission needed', question: 'Your answer is needed', idle: 'Task finished — waiting for you', 'goal-blocked': 'Goal blocked', error: 'Run failed' },
    approval: (tool) => `Approve running ${tool}`,
    unknownTool: 'unknown tool',
    options: 'Options:',
    moreQuestions: (header, count) => `${header} (${count} more ${count === 1 ? 'question' : 'questions'} waiting)`,
    idle: 'The turn ended and DSH is waiting for your next instruction',
    goalBlocked: 'The goal is blocked and needs you',
    error: 'The run failed and needs your attention',
  },
}

const EXCERPT_CHARS = 600
const PREVIEW_CHARS = 300
/** WeCom rejects a markdown `content` longer than 4096 UTF-8 bytes (errcode 40058). */
const WECOM_MAX_BYTES = 4096
const TIMEOUT_MS = 10_000
/**
 * How long an agent must stay idle before "task finished" is sent. A goal
 * round, a queued follow-up, or a subagent result wakes the agent again
 * within milliseconds; only an idle that sticks means DSH is waiting for you.
 */
export const IDLE_SETTLE_MS = 2_000
/** Tool-call argument fields worth showing on an approval, most telling first. */
const PREVIEW_FIELDS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern']

/** Map a BCP 47 tag onto the two languages this plugin writes, the way DSH's own UI falls back. */
function languageOf(tag) {
  return tag.trim().toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh' : 'en'
}

/**
 * The language DSH itself is currently showing: whatever the user picked in
 * Settings → General → Language (the `locale` plugin row's volatile
 * `preference` field, read through the optional `configEditor` service),
 * falling back to the host OS/process locale when nothing was explicitly
 * chosen — Chinese for a Chinese locale, English otherwise, as DSH's UI does —
 * and to `zh` when neither is readable.
 */
function currentLocale(ctx) {
  try {
    const editor = ctx.get('configEditor')
    for (const { entry } of editor?.configuration() ?? []) {
      if (entry?.options?.id !== 'locale') continue
      const raw = entry.fiber?.config?.preference
      const preference = typeof raw?.get === 'function' ? raw.get() : raw
      if (typeof preference === 'string' && preference.trim() !== '') return languageOf(preference)
      break
    }
  } catch {
    // No configEditor, or the locale row is not composed; fall through.
  }
  try {
    const system = Intl.DateTimeFormat().resolvedOptions().locale
    if (typeof system === 'string' && system !== '') return languageOf(system)
  } catch {
    // Intl unavailable; fall through to the default below.
  }
  return 'zh'
}

export function apply(ctx, config) {
  const log = (level, message) => (ctx.logger ?? console)[level](`[${name}] ${message}`)
  const currentUrl = () => {
    const raw = typeof config?.url?.get === 'function' ? config.url.get() : config?.url
    return typeof raw === 'string' ? raw.trim() : ''
  }

  // Fire-and-forget: a slow robot must never delay an approval or a turn.
  // `build` runs only once a URL is configured, given DSH's current language.
  // Nothing here may throw into a listener: the approval and question
  // listeners must always reach `next()`, or DSH would fail the request closed.
  const notify = (build) => {
    try {
      const url = currentUrl()
      if (url === '') return
      const locale = currentLocale(ctx)
      void send(url, renderWecom(build(TEXT[locale], locale), locale))
        .catch((error) => log('warn', `delivery failed: ${describeError(error)}`))
    } catch (error) {
      log('warn', `could not build the notification: ${describeError(error)}`)
    }
  }

  const identity = (agent) => {
    const session = get(agent, ['session'])
    let title
    try {
      const snapshot = ctx.get('sessionTitle')?.get?.(session)
      title = typeof snapshot === 'string' ? snapshot : pick(snapshot, ['title'], ['value'], ['text'])
    } catch {}
    title ??= pick(session, ['title'], ['header', 'title'], ['titleSnapshot', 'title'])
    return {
      session: title ?? pick(agent, ['id'], ['session', 'id'], ['sessionId']) ?? '',
      cwd: pick(session, ['header', 'cwd'], ['cwd'], ['options', 'cwd']) ?? '',
    }
  }

  // Two small facts read off the live event stream, so nothing has to re-read
  // the session log: how each session's latest turn ended, and the tool calls
  // its latest assistant message made (an approval names only the call id).
  const turnEndings = new WeakMap()
  const toolCalls = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (session === null || typeof session !== 'object') return
    const type = get(event, ['type'])
    if (type === 'turn/end') turnEndings.set(session, pick(event, ['data', 'reason', 'kind']) ?? 'completed')
    else if (type === 'assistant/message') toolCalls.set(session, toolCallsOf(get(event, ['data', 'message', 'content'])))
  })

  // approval/request and user-questions/request are waterfalls whose real
  // answerer never calls next(); `prepend` keeps this pass-through listener
  // outermost so it always sees the request.
  ctx.on('approval/request', async (request, next) => {
    notify((t, locale) => {
      const args = toolCalls.get(get(request, ['agent', 'session']))?.get(pick(request, ['callId']))
      return {
        kind: 'approval',
        ...identity(request?.agent),
        summary: t.approval(pick(request, ['toolName']) ?? t.unknownTool),
        detail: localized(get(request, ['displayReason']), locale) ?? pick(request, ['reason']),
        preview: argumentPreview(args),
      }
    })
    return next()
  }, { prepend: true })

  ctx.on('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length > 0) {
      notify((t) => {
        const [first, ...rest] = questions
        const header = pick(first, ['header'], ['id']) ?? 'question'
        const options = (Array.isArray(first?.options) ? first.options : [])
          .map((option) => (typeof option === 'string' ? option.trim() : pick(option, ['label'], ['text'], ['value'], ['title'])))
          .filter(Boolean)
        const detail = [pick(first, ['question']), options.length > 0 ? [t.options, ...options.map((o) => `- ${o}`)].join('\n') : undefined]
        return {
          kind: 'question',
          ...identity(request?.agent),
          summary: rest.length > 0 ? t.moreQuestions(header, rest.length) : header,
          detail: detail.filter(Boolean).join('\n\n'),
          items: rest.map((q) => pick(q, ['header'], ['question'])).filter(Boolean),
        }
      })
    }
    return next()
  }, { prepend: true })

  // "Task finished" only when DSH is really waiting for a person: not for a
  // subagent (its parent carries on), not after a stop the user pressed or an
  // error already reported, and only once the agent has stayed idle.
  const settling = new Map()
  ctx.effect?.(() => () => {
    for (const timer of settling.values()) clearTimeout(timer)
    settling.clear()
  }, `${name}: pending idle notifications`)

  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    clearTimeout(settling.get(agent))
    settling.delete(agent)
    if (pick(payload, ['status']) !== 'idle' || isSubagent(agent)) return
    const ending = turnEndings.get(get(agent, ['session']))
    if (ending === 'aborted' || ending === 'error') return
    const timer = setTimeout(() => {
      settling.delete(agent)
      if (agent?.status !== undefined && agent.status !== 'idle') return
      notify((t) => ({ kind: 'idle', ...identity(agent), summary: lastAssistantMessage(get(agent, ['session'])) ?? t.idle }))
    }, IDLE_SETTLE_MS)
    timer.unref?.()
    settling.set(agent, timer)
  })

  ctx.on('goal/changed', (payload) => {
    const change = payload?.change
    if (pick(change, ['operation']) !== 'block') return
    const objective = pick(change, ['goal', 'objective'])
    notify((t) => ({
      kind: 'goal-blocked',
      ...identity(payload.agent),
      summary: t.goalBlocked,
      detail: pick(change, ['goal', 'blockedReason', 'message']),
      items: objective ? [objective] : [],
    }))
  })

  ctx.on('agent/error', (payload) => {
    if (isSubagent(payload?.agent)) return
    notify((t) => ({ kind: 'error', ...identity(payload?.agent), summary: t.error, detail: describeError(payload?.error) }))
  })

  log('info', currentUrl() === '' ? 'ready — no url configured yet; set it on the Plugins page' : 'ready')
}

/**
 * Render one notification as WeCom's `{msgtype: 'markdown'}` body, in `locale`
 * (`'zh'` or `'en'`), within WeCom's 4096-byte content limit.
 */
export function renderWecom({ kind, summary, detail, preview, items, session, cwd }, locale = 'zh') {
  const titles = (TEXT[locale] ?? TEXT.zh).titles
  const footer = [cwd ? `📁 ${basename(cwd)}` : '', session ? `💬 ${session}` : ''].filter(Boolean).join('  ·  ')
  const body = [
    truncate(summary ?? '', EXCERPT_CHARS),
    truncate(detail ?? '', EXCERPT_CHARS),
    renderPreview(preview),
    (items ?? []).filter((item) => typeof item === 'string' && item.trim()).map((item) => `- ${truncate(item, EXCERPT_CHARS)}`).join('\n'),
    footer,
  ].filter(Boolean).join('\n\n')
  const content = `**${titles[kind] ?? kind}**\n${body}`
  return { msgtype: 'markdown', markdown: { content: truncateBytes(content, WECOM_MAX_BYTES) } }
}

async function send(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  // WeCom answers HTTP 200 even when it rejects a message; the verdict is errcode.
  const errcode = response.ok ? safeJson(text)?.errcode ?? 0 : undefined
  if (errcode !== 0) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
}

/** The newest assistant text on a live DSH Session's surface. */
export function lastAssistantMessage(session) {
  const nodes = get(session, ['surface', 'nodes'])
  if (!Array.isArray(nodes) || typeof session?.eventAt !== 'function') return undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (pick(event, ['type']) !== 'assistant/message') continue
    const text = textOf(get(event, ['data', 'message', 'content']))
    if (text.length > 0) return text
  }
  return undefined
}

/** A subagent's session header names the session that delegated to it. */
function isSubagent(agent) {
  return pick(agent, ['session', 'header', 'parentSession']) !== undefined
}

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  return (Array.isArray(content) ? content : [])
    .filter((block) => get(block, ['type']) === undefined || get(block, ['type']) === 'text')
    .map((block) => pick(block, ['text']) ?? '')
    .join('\n')
    .trim()
}

/** `callId → arguments` for the `tool-call` blocks of one assistant message. */
function toolCallsOf(content) {
  const calls = new Map()
  for (const block of Array.isArray(content) ? content : []) {
    if (get(block, ['type']) !== 'tool-call') continue
    const id = pick(block, ['id'])
    if (id !== undefined) calls.set(id, get(block, ['arguments']))
  }
  return calls
}

/** The one argument that says what an approval is about: a command, a path, a URL... */
function argumentPreview(args) {
  const parsed = typeof args === 'string' ? safeJson(args) : args
  const value = pick(parsed, ...PREVIEW_FIELDS.map((field) => [field]))
  return value === undefined ? undefined : truncate(value, PREVIEW_CHARS)
}

/** Inline code for one plain line; a quote block for anything code spans cannot hold. */
function renderPreview(preview) {
  if (typeof preview !== 'string' || preview.trim() === '') return ''
  const text = preview.trim()
  if (!text.includes('\n') && !text.includes('`')) return `\`${text}\``
  return text.split('\n').map((line) => `> ${line}`).join('\n')
}

/** Pick `locale`'s text from a `{zh, en}` display string, then the other one. */
function localized(value, locale) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  return pick(value, [locale], [locale === 'zh' ? 'en' : 'zh'])
}

function get(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function pick(value, ...paths) {
  for (const path of paths) {
    const found = get(value, path)
    if (typeof found === 'string' && found.trim().length > 0) return found
  }
  return undefined
}

/** Trim to `limit` characters (code points, so an emoji is never split in half). */
function truncate(text, limit) {
  const normalized = String(text).replace(/\r\n?/g, '\n').trim()
  const chars = Array.from(normalized)
  return chars.length <= limit ? normalized : `${chars.slice(0, limit - 1).join('').trimEnd()}…`
}

/** Trim to `limit` UTF-8 bytes — a CJK character is 3 bytes, an emoji 4. */
function truncateBytes(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text
  const ellipsis = '…'
  let budget = limit - Buffer.byteLength(ellipsis)
  let out = ''
  for (const char of text) {
    budget -= Buffer.byteLength(char)
    if (budget < 0) break
    out += char
  }
  return `${out.trimEnd()}${ellipsis}`
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  if (error == null) return 'unknown error'
  try {
    return pick(error, ['message'], ['error', 'message'], ['reason']) ?? JSON.stringify(error).slice(0, 500)
  } catch {
    return String(error)
  }
}
