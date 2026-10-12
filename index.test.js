import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { Config, IDLE_SETTLE_MS, apply, renderWecom } from './index.js'

/** A fake `configEditor` exposing one `locale` row with a given preference. */
function fakeConfigEditor(preference) {
  return {
    configuration: () => [{ entry: { options: { id: 'locale' }, fiber: { config: { preference: { get: () => preference } } } } }],
  }
}

/**
 * A fake Cordis context: records listeners and lets a test fire them. DSH's
 * own language setting is stubbed through `configEditor`, matching how
 * `currentLocale` reads it — see `index.js` — so no test depends on the real
 * host OS/`Intl` locale.
 */
function harness(url, locale = 'zh') {
  const listeners = {}
  const sent = []
  globalThis.fetch = async (target, init) => {
    sent.push({ url: target, body: JSON.parse(init.body) })
    return new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 })
  }
  const ctx = {
    get: (key) => (key === 'configEditor' ? fakeConfigEditor(locale) : undefined),
    on: (event, handler) => { listeners[event] = handler },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, { url: { get: () => url } })
  return { listeners, sent }
}

/** Let the fire-and-forget `fetch` chain settle. Not a timer, so mocked timers don't stall it. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const assistantMessage = (content) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } })

function makeAgent({ parentSession, status = 'idle' } = {}) {
  return {
    id: 's1',
    status,
    session: {
      title: '重构登录',
      header: { cwd: '/work/my-app', ...(parentSession ? { parentSession } : {}) },
      surface: { nodes: [0] },
      eventAt: () => assistantMessage([{ type: 'text', text: '全部完成。' }]),
    },
  }
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

test('Config exposes only a volatile url field', () => {
  assert.deepEqual(Object.keys(Config.dict), ['url'])
  assert.equal(Config.dict.url.meta.volatile, true)
})

test('renders a wecom-format markdown body', () => {
  const body = renderWecom({ kind: 'approval', summary: '需要授权执行 bash', detail: 'rm -rf build', items: ['bash'], session: '重构登录', cwd: '/work/my-app' })
  assert.deepEqual(body, {
    msgtype: 'markdown',
    markdown: { content: '**需要授权**\n需要授权执行 bash\n\nrm -rf build\n\n- bash\n\n📁 my-app  ·  💬 重构登录' },
  })
})

test('the rendered content stays within WeCom\'s 4096-byte limit, CJK and emoji included', () => {
  const huge = '中'.repeat(600)
  const { markdown } = renderWecom({ kind: 'question', summary: huge, detail: huge, items: Array.from({ length: 10 }, () => `${'😀'.repeat(300)}`) })
  assert.ok(Buffer.byteLength(markdown.content) <= 4096, `${Buffer.byteLength(markdown.content)} bytes`)
  assert.ok(markdown.content.endsWith('…'))
  assert.doesNotMatch(markdown.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no half of a surrogate pair')
})

test('approval notifies, shows the command from the tool call, and passes through to next', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const agent = makeAgent()
  listeners['session/event'](agent.session, assistantMessage([
    { type: 'text', text: '先清理一下。' },
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"rm -rf build"}' },
  ]))
  const result = await listeners['approval/request']({
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: delete build output',
    displayReason: { en: 'Allow this operation with danger-full-access permissions', zh: '允许本次操作使用 danger-full-access 权限' },
  }, async () => 'allowed-once')
  await flush()
  assert.equal(result, 'allowed-once')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://qyapi.example/hook')
  assert.equal(sent[0].body.markdown.content,
    '**需要授权**\n需要授权执行 bash\n\n允许本次操作使用 danger-full-access 权限\n\n`rm -rf build`\n\n📁 my-app  ·  💬 重构登录')
})

test('a malformed request still reaches next(), so DSH never fails an approval closed because of this plugin', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const hostile = { get agent() { throw new Error('boom') }, toolName: 'bash' }
  assert.equal(await listeners['approval/request'](hostile, async () => 'allowed-once'), 'allowed-once')
  await flush()
  assert.equal(sent.length, 0)
})

test('a multi-line or backticked command is quoted instead of inlined', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const agent = makeAgent()
  listeners['session/event'](agent.session, assistantMessage([
    { type: 'tool-call', id: 'call-2', name: 'bash', arguments: JSON.stringify({ command: 'cd app\necho `date`' }) },
  ]))
  await listeners['approval/request']({ agent, toolName: 'bash', callId: 'call-2' }, async () => 'rejected')
  await flush()
  assert.match(sent[0].body.markdown.content, /\n> cd app\n> echo `date`\n/)
})

test('idle sends the last assistant message once the agent stays idle', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const agent = makeAgent()
  listeners['agent/status']({ agent, status: 'running' })
  listeners['agent/status']({ agent, status: 'idle' })
  mock.timers.tick(IDLE_SETTLE_MS - 1)
  await flush()
  assert.equal(sent.length, 0, 'nothing before the settle window')
  mock.timers.tick(1)
  await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.markdown.content, '**任务已完成，等待下一步**\n全部完成。\n\n📁 my-app  ·  💬 重构登录')
})

test('an idle that is woken again right away (goal round, queued follow-up) sends nothing', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const agent = makeAgent()
  listeners['agent/status']({ agent, status: 'idle' })
  mock.timers.tick(100)
  agent.status = 'running'
  listeners['agent/status']({ agent, status: 'running' })
  mock.timers.tick(IDLE_SETTLE_MS)
  await flush()
  assert.equal(sent.length, 0)
})

test('idle is skipped for a subagent, a stopped turn, and a turn that already reported an error', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  listeners['agent/status']({ agent: makeAgent({ parentSession: 'parent-1' }), status: 'idle' })
  for (const kind of ['aborted', 'error']) {
    const agent = makeAgent()
    listeners['session/event'](agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
    listeners['agent/status']({ agent, status: 'idle' })
  }
  mock.timers.tick(IDLE_SETTLE_MS)
  await flush()
  assert.equal(sent.length, 0)
})

test('a blocked goal notifies with its reason and objective', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  const agent = makeAgent()
  // The shape dsh-goal emits: `{agent, change: {operation, ref, goal}}`.
  const change = (operation) => ({
    operation,
    ref: { id: 'g1', revision: 3 },
    goal: { id: 'g1', revision: 3, objective: '迁移到新的登录接口', phase: 'blocked', blockedReason: { code: 'needs-credentials', message: '缺少测试环境的账号' } },
  })
  listeners['goal/changed']({ agent, change: change('edit') })
  listeners['goal/changed']({ agent, change: change('block') })
  await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.markdown.content,
    '**目标被阻塞**\n目标被阻塞，需要你介入\n\n缺少测试环境的账号\n\n- 迁移到新的登录接口\n\n📁 my-app  ·  💬 重构登录')
})

test('errors notify for a top-level agent only', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook')
  listeners['agent/error']({ agent: makeAgent({ parentSession: 'parent-1' }), error: new Error('child boom') })
  listeners['agent/error']({ agent: makeAgent(), error: new Error('boom') })
  await flush()
  assert.equal(sent.length, 1)
  assert.match(sent[0].body.markdown.content, /^\*\*执行出错\*\*\n执行出错，需要你确认\n\nError: boom\n/)
})

test('nothing is sent while the url is empty', async () => {
  const { listeners, sent } = harness('')
  listeners['agent/error']({ agent: makeAgent(), error: new Error('boom') })
  await flush()
  assert.equal(sent.length, 0)
})

test('title and body follow DSH\'s own language setting (Settings → General → Language), not an env var', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook', 'en')
  const agent = makeAgent()
  listeners['agent/error']({ agent, error: new Error('boom') })
  await listeners['approval/request']({ agent, toolName: 'bash', displayReason: { en: 'Allow full access', zh: '允许完全访问' } }, async () => 'rejected')
  await listeners['user-questions/request']({ agent, questions: [{ header: 'Scope', question: 'Which files?', options: [{ label: 'All' }] }, { header: 'Deadline' }] }, async () => ({}))
  await flush()
  assert.equal(sent.length, 3)
  assert.match(sent[0].body.markdown.content, /^\*\*Run failed\*\*\nThe run failed and needs your attention\n/)
  assert.match(sent[1].body.markdown.content, /^\*\*Permission needed\*\*\nApprove running bash\n\nAllow full access\n/)
  assert.match(sent[2].body.markdown.content, /^\*\*Your answer is needed\*\*\nScope \(1 more question waiting\)\n\nWhich files\?\n\nOptions:\n- All\n\n- Deadline\n/)
})

test('a language DSH does not ship falls back to English, as DSH\'s own UI does', async () => {
  const { listeners, sent } = harness('https://qyapi.example/hook', 'ja')
  listeners['agent/error']({ agent: makeAgent(), error: new Error('boom') })
  await flush()
  assert.match(sent[0].body.markdown.content, /^\*\*Run failed\*\*/)
})

test('package.json declares an icon and display metadata DSH\'s Plugins page can read', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  // Mirrors DSH's reader: a relative SVG/PNG/JPEG/WebP of at most 256 KiB, shipped and exported.
  assert.match(manifest.icon, /^\.\/[\w-]+\.(svg|png|jpe?g|webp)$/)
  assert.ok(statSync(new URL(manifest.icon, import.meta.url)).size <= 256 * 1024)
  assert.ok(manifest.files.includes(manifest.icon.slice(2)))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./package.json'], './package.json')
  for (const language of ['en', 'zh']) {
    const { meta } = JSON.parse(readFileSync(new URL(`./locale/${language}.json`, import.meta.url), 'utf8'))
    assert.equal(typeof meta.title, 'string')
    assert.equal(typeof meta.description, 'string')
  }
})

test('peerDependencies and devDependencies keep schemastery on the identical range', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], manifest.devDependencies['@deepseek-ai/schemastery'])
})
