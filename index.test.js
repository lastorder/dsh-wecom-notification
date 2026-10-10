import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, apply, renderWecom } from './index.js'

/** A fake `configEditor` exposing one `locale` row with a given preference. */
function fakeConfigEditor(preference) {
  return {
    configuration: () => [{ entry: { options: { id: 'locale' }, fiber: { config: { preference: { get: () => preference } } } } }],
  }
}

/**
 * A fake Cordis context: records listeners and lets a test fire them. DSH's
 * own language setting is stubbed through `configEditor`, matching how
 * `currentLocale` reads it — see `index.js`.
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
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10))
  return { listeners, sent, flush }
}

const agent = {
  id: 's1',
  session: {
    title: '重构登录',
    header: { cwd: '/work/my-app' },
    surface: { nodes: [0] },
    eventAt: () => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '全部完成。' }] } } }),
  },
}

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

test('approval notifies and passes through to next', async () => {
  const { listeners, sent, flush } = harness('https://qyapi.example/hook')
  const result = await listeners['approval/request']({ agent, toolName: 'bash', reason: 'needs shell' }, async () => 'allow')
  await flush()
  assert.equal(result, 'allow')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://qyapi.example/hook')
  assert.match(sent[0].body.markdown.content, /^\*\*需要授权\*\*\n需要授权执行 bash/)
})

test('idle sends the last assistant message', async () => {
  const { listeners, sent, flush } = harness('https://qyapi.example/hook')
  listeners['agent/status']({ agent, status: 'idle' })
  listeners['agent/status']({ agent, status: 'running' })
  await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.markdown.content, '**任务已完成，等待下一步**\n全部完成。\n\n📁 my-app  ·  💬 重构登录')
})

test('nothing is sent while the url is empty', async () => {
  const { listeners, sent, flush } = harness('')
  listeners['agent/error']({ agent, error: new Error('boom') })
  await flush()
  assert.equal(sent.length, 0)
})

test('the title follows DSH\'s own language setting (Settings → General → Language), not an env var', async () => {
  const { listeners, sent, flush } = harness('https://qyapi.example/hook', 'en')
  listeners['agent/error']({ agent, error: new Error('boom') })
  await flush()
  assert.match(sent[0].body.markdown.content, /^\*\*Run failed\*\*/)
})
