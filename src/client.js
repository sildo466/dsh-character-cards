// dsh-character-cards - client half.
//
// P0 skeleton: prove the browser half loads and can claim a slot without
// disturbing the rest of the client composition. The only contribution is a
// detail pane on this bundle's row in the plugin manager, which doubles as the
// visible marker that the package installed. Card picking and editing arrive
// in P3/P4.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with window.__ModuleLoader__ and returns apply(). `react` is a
// platform module (packages/client/web/src/platform.ts), seeded into the frozen
// module table before any bundle materializes, so it needs no `dsh.client.inject`
// edge. Everything else is read through ctx.get() with an absence check.
window.__ModuleLoader__.load({
  id: 'dsh-character-cards',
  factory: (require) => {
    const react = require('react')

    /**
     * Detail pane for this bundle's row in the plugin manager.
     * @param {{ view?: string }} props - slot props; `summary` renders the one-line row.
     * @returns {unknown} a React element, or the summary string.
     */
    function CardSection({ view } = {}) {
      if (view === 'summary') return '角色卡骨架已装载（P0）'
      return react.createElement(
        'div',
        { style: { padding: '8px 0', lineHeight: 1.6 } },
        react.createElement('p', { style: { margin: 0 } }, 'dsh-character-cards 已装载。'),
        react.createElement(
          'p',
          { style: { margin: '4px 0 0', opacity: 0.7 } },
          'P0 骨架：宿主与客户端两半均已激活，尚未接入角色卡。',
        ),
      )
    }

    /**
     * Activate the browser half.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     */
    function apply(ctx) {
      // Every step is optional and silent on failure: a client plugin that
      // throws out of apply() can take the whole client composition down with
      // it, which is how plugin entries disappear from the UI entirely.
      try {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('plugins.row.config', () => slots.register(
          { name: 'plugins.row.config', key: 'dsh-character-cards#dsh-character-cards' },
          CardSection,
        ))
      } catch {
        // A missing or reshaped slot must degrade to "no card pane", never to
        // a broken client.
      }
    }

    return { apply }
  },
})
