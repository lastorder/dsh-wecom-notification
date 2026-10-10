/**
 * dsh-wecom-notification — Client half.
 *
 * Adds the one setting this plugin has — the WeCom robot webhook URL — to the
 * plugin's own page under the sidebar's Plugins entry (`plugins.bundle.config`).
 * Values are read and written through `ctx.configForms`, so a save lands in
 * the profile's cordis.patch.yml and reaches the Host's volatile `url` live.
 *
 * Plain classic script in the client module loader's lazy factory format; no
 * build step, React comes from the page's module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wecom-notification',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useSyncExternalStore } = React

    const PKG = 'dsh-wecom-notification'
    const ROW = 'wecom-notification'
    const NS = 'wecomNotification'

    const zh = {
      title: '企业微信群机器人 Webhook 地址',
      hint: 'DSH 需要你处理时（授权、提问、任务完成、目标阻塞、出错），会立即推送到这个群机器人。获取方式见插件 README。',
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败',
      invalid: '请输入以 http:// 或 https:// 开头的地址，或留空以关闭通知',
      loading: '正在读取配置…',
      unavailable: '当前无法编辑配置：请确认插件已启用，或直接编辑 profile 的 cordis.patch.yml',
    }
    const en = {
      title: 'WeCom group robot webhook URL',
      hint: 'Whenever DSH needs you (approval, question, finished task, blocked goal, error) it pushes to this robot right away. See the plugin README for how to get one.',
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed',
      invalid: 'Enter an http:// or https:// URL, or leave it empty to turn notifications off',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is not editable right now: make sure the plugin is enabled, or edit the profile cordis.patch.yml',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 8 },
      label: { fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      input: {
        flex: 1, minWidth: 0, height: 32, padding: '0 10px', fontSize: 13, borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', outline: 'none', fontFamily: 'inherit',
      },
      button: {
        height: 32, padding: '0 14px', fontSize: 13, borderRadius: 8, border: 'none', cursor: 'pointer',
        background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontFamily: 'inherit',
      },
      status: (tone) => ({ fontSize: 12, margin: 0, color: `var(--dsw-alias-state-${tone}-primary)` }),
    }

    function UrlForm({ form, t }) {
      const snapshot = useSyncExternalStore((listener) => form.subscribe(listener), () => form.getSnapshot())
      const stored = typeof snapshot.value?.url === 'string' ? snapshot.value.url : ''
      const [draft, setDraft] = useState(undefined)
      const [status, setStatus] = useState(undefined)
      const value = draft ?? stored
      const busy = status === 'saving'
      const editable = snapshot.status === 'ready' && snapshot.writable

      const save = async () => {
        const url = value.trim()
        if (url !== '' && !/^https?:\/\/\S+$/i.test(url)) return setStatus('invalid')
        setStatus('saving')
        try {
          const op = url === '' ? { op: 'unset', path: ['url'] } : { op: 'set', path: ['url'], value: url }
          const ok = await form.mutate([op], snapshot.revision)
          setStatus(ok ? 'saved' : 'failed')
          if (ok) setDraft(undefined)
        } catch {
          setStatus('failed')
        }
      }

      const message = snapshot.status === 'loading' ? ['idle', t('loading')]
        : !editable ? ['warn', t('unavailable')]
        : status === 'saved' ? ['success', t('saved')]
        : status === 'failed' ? ['error', t('failed')]
        : status === 'invalid' ? ['error', t('invalid')]
        : undefined

      return h('div', { style: styles.root, 'data-wecom-notification-config': '' },
        h('label', { style: styles.label, htmlFor: 'wecom-notification-url' }, t('title')),
        h('p', { style: styles.hint }, t('hint')),
        h('div', { style: styles.row },
          h('input', {
            id: 'wecom-notification-url', type: 'url', style: styles.input, value, spellCheck: false,
            placeholder: t('placeholder'), disabled: !editable || busy,
            onChange: (event) => { setDraft(event.target.value); setStatus(undefined) },
            onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() },
          }),
          h('button', {
            type: 'button', style: { ...styles.button, opacity: !editable || busy || value === stored ? 0.5 : 1 },
            disabled: !editable || busy || value === stored, onClick: () => void save(),
          }, busy ? t('saving') : t('save'))),
        message ? h('p', { style: styles.status(message[0]), role: 'status' }, message[1]) : null)
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'wecom-notification: locale')
        const bound = ctx.locale.bind(NS)
        const form = ctx.configForms.get(ROW)
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PKG,
          locale: NS,
        }, ({ view, t }) => (view === 'page' ? h(UrlForm, { form, t: t ?? bound }) : null))), 'wecom-notification: config page')
      },
    }
  },
})
