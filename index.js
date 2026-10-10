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

/** Trigger labels, in the two languages DSH itself ships. */
const LABELS = {
  zh: { approval: '需要授权', question: '等待你的回答', idle: '任务已完成，等待下一步', 'goal-blocked': '目标被阻塞', error: '执行出错' },
  en: { approval: 'Permission needed', question: 'Your answer is needed', idle: 'Task finished — waiting for you', 'goal-blocked': 'Goal blocked', error: 'Run failed' },
}

const EXCERPT_CHARS = 600
const WECOM_MAX_CHARS = 3000
const TIMEOUT_MS = 10_000

/**
 * The language DSH itself is currently showing: whatever the user picked in
 * Settings → General → Language (the `locale` plugin row's volatile
 * `preference` field, read through the optional `configEditor` service),
 * falling back to the host OS/process locale when nothing was explicitly
 * chosen, and to `zh` when neither is readable.
 */
function currentLocale(ctx) {
  try {
    const editor = ctx.get('configEditor')
    for (const { entry } of editor?.configuration() ?? []) {
      if (entry.options.id !== 'locale') continue
      const raw = entry.fiber?.config?.preference
      const preference = typeof raw?.get === 'function' ? raw.get() : raw
      if (preference === 'zh' || preference === 'en') return preference
      break
    }
  } catch {
    // No configEditor, or the locale row is not composed; fall through.
  }
  try {
    if (Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('en')) return 'en'
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
  const notify = (payload) => {
    if (payload === undefined) return
    const url = currentUrl()
    if (url === '') return
    const labels = LABELS[currentLocale(ctx)] ?? LABELS.zh
    void send(url, payload, labels).catch((error) => log('warn', `delivery failed: ${describeError(error)}`))
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

  // approval/request and user-questions/request are waterfalls whose real
  // answerer never calls next(); `prepend` keeps this pass-through listener
  // outermost so it always sees the request.
  ctx.on('approval/request', async (request, next) => {
    const tool = pick(request, ['toolName']) ?? 'unknown tool'
    const reason = pick(request, ['displayReason', 'zh'], ['displayReason', 'en'], ['reason'])
    notify({ kind: 'approval', ...identity(request?.agent), summary: `需要授权执行 ${tool}`, detail: reason, items: [tool] })
    return next()
  }, { prepend: true })

  ctx.on('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length > 0) {
      const [first, ...rest] = questions
      const header = pick(first, ['header'], ['id']) ?? 'question'
      const options = (Array.isArray(first?.options) ? first.options : [])
        .map((option) => (typeof option === 'string' ? option.trim() : pick(option, ['label'], ['text'], ['value'], ['title'])))
        .filter(Boolean)
      const detail = [pick(first, ['question']), options.length > 0 ? ['可选项：', ...options.map((o) => `- ${o}`)].join('\n') : undefined]
      notify({
        kind: 'question',
        ...identity(request.agent),
        summary: rest.length > 0 ? `${header}（还有 ${rest.length} 个问题待回答）` : header,
        detail: detail.filter(Boolean).join('\n\n'),
        items: rest.map((q) => pick(q, ['header'], ['question'])).filter(Boolean),
      })
    }
    return next()
  }, { prepend: true })

  ctx.on('agent/status', (payload) => {
    if (pick(payload, ['status']) !== 'idle') return
    const summary = lastAssistantMessage(get(payload.agent, ['session'])) ?? '任务已结束，等待你的下一步指示'
    notify({ kind: 'idle', ...identity(payload.agent), summary })
  })

  ctx.on('goal/changed', (payload) => {
    const change = payload?.change
    if (pick(change, ['kind'], ['type']) !== 'blocked') return
    const objective = pick(change, ['goal', 'objective'], ['objective'])
    notify({
      kind: 'goal-blocked',
      ...identity(payload.agent),
      summary: '目标被阻塞，需要你介入',
      detail: pick(change, ['reason'], ['blockReason'], ['goal', 'blockReason']),
      items: objective ? [objective] : [],
    })
  })

  ctx.on('agent/error', (payload) => {
    notify({ kind: 'error', ...identity(payload?.agent), summary: '执行出错，需要你确认', detail: describeError(payload?.error) })
  })

  log('info', currentUrl() === '' ? 'ready — no url configured yet; set it on the Plugins page' : 'ready')
}

/** Render one notification as WeCom's `{msgtype: 'markdown'}` body. */
export function renderWecom({ kind, summary, detail, items, session, cwd }, labels = LABELS.zh) {
  const footer = [cwd ? `📁 ${basename(cwd)}` : '', session ? `💬 ${session}` : ''].filter(Boolean).join('  ·  ')
  const body = [
    truncate(summary ?? '', EXCERPT_CHARS),
    truncate(detail ?? '', EXCERPT_CHARS),
    (items ?? []).filter((item) => typeof item === 'string' && item.trim()).map((item) => `- ${item.trim()}`).join('\n'),
    footer,
  ].filter(Boolean).join('\n\n')
  const content = `**${labels[kind] ?? kind}**\n${body}`
  return { msgtype: 'markdown', markdown: { content: truncate(content, WECOM_MAX_CHARS) } }
}

async function send(url, payload, labels) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(renderWecom(payload, labels)),
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
    const content = get(event, ['data', 'message', 'content'])
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : []).map((block) => pick(block, ['text']) ?? '').join('\n').trim()
    if (text.length > 0) return text
  }
  return undefined
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

function truncate(text, limit) {
  const normalized = String(text).replace(/\r\n?/g, '\n').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`
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
