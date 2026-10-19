// dsh-character-cards - client half.
//
// A self-adaptive card switcher: a slot that hands over a `sessionId` switches
// that session's card, a slot that does not switches the global default. The
// same component serves both surfaces; `switcherMode` makes the choice explicit
// and testable.
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

    // A package whose client half cannot be required takes the whole module
    // down, and an unregistered specifier throws on the spot rather than
    // returning undefined. So the lookup is guarded, and the switcher falls
    // back to a plain select when the primitives are not where this build
    // expects them - a plain control beats a broken client.
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = undefined
    }
    const Menu = primitives?.Menu
    const Pill = primitives?.Pill
    const Chevron = primitives?.IconChevronDownOutline14
    const canUseMenu = typeof Menu === 'function' && typeof Pill === 'function'

    // Editor primitives. Looked up the same guarded way as the switcher's:
    // an undefined component handed to react.createElement throws, so the
    // settings page checks these before it renders anything and degrades to a
    // message when the build does not export them.
    const Input = primitives?.Input
    const Button = primitives?.Button
    const DisclosureRow = primitives?.DisclosureRow

    const ROUTE = '/dsh-character-cards'

    /**
     * Read a nested field without throwing on a missing parent.
     * @param card - the card.
     * @param path - dot-separated field path.
     * @returns the value, or undefined.
     */
    function fieldOf(card, path) {
      let cursor = card
      for (const part of path.split('.')) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[part]
      }
      return cursor
    }

    /**
     * Return a copy of a card with one nested field replaced.
     *
     * The copy comes from structuredClone and only the named path is assigned,
     * so every field this build does not know survives (GOAL D6). Rebuilding
     * the card from a field list would silently delete them on the first save.
     * @param card - the card to copy.
     * @param path - dot-separated field path.
     * @param value - the replacement value.
     * @returns a new card.
     */
    function withField(card, path, value) {
      const parts = path.split('.')
      const copy = structuredClone(card)
      let cursor = copy
      for (const part of parts.slice(0, -1)) {
        if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
          cursor[part] = {}
        }
        cursor = cursor[part]
      }
      cursor[parts[parts.length - 1]] = value
      return copy
    }

    /**
     * The five editable groups, in render order, with their D2 impact badges.
     *
     * `kind` decides the control: `text` is one Input, `list` is a row per
     * entry, `bool` is a Pill toggle.
     * @returns the group descriptors.
     */
    function editorGroups() {
      return [
        {
          key: 'identity',
          title: '身份',
          badge: '低风险 · 影响视角与用词',
          fields: [
            { path: 'identity.role', label: '角色', kind: 'text' },
            { path: 'identity.expertise', label: '专长', kind: 'list' },
            { path: 'identity.background', label: '背景', kind: 'text' },
          ],
        },
        {
          key: 'voice',
          title: '表达',
          badge: '安全 · 只影响表达，不影响正确性',
          fields: [
            { path: 'voice.tone', label: '语气', kind: 'text' },
            { path: 'voice.verbosity', label: '篇幅', kind: 'text' },
            { path: 'voice.formality', label: '正式度', kind: 'text' },
            { path: 'voice.humor', label: '幽默', kind: 'text' },
            { path: 'voice.traits', label: '性格', kind: 'list' },
            { path: 'voice.avoid', label: '禁止', kind: 'list' },
          ],
        },
        {
          key: 'code',
          title: '代码风格',
          badge: '会改变代码 · 影响产出质量与风格',
          fields: [
            { path: 'code.naming', label: '命名', kind: 'text' },
            { path: 'code.comments', label: '注释', kind: 'text' },
            { path: 'code.error_handling', label: '错误处理', kind: 'text' },
            { path: 'code.abstraction', label: '抽象', kind: 'text' },
            { path: 'code.dependencies', label: '依赖', kind: 'text' },
            { path: 'code.tests', label: '测试', kind: 'text' },
            { path: 'code.commit_style', label: '提交信息', kind: 'text' },
          ],
        },
        {
          key: 'workflow',
          title: '工作方式',
          badge: '高风险 · 影响行为决策',
          fields: [
            { path: 'workflow.plan', label: '计划', kind: 'text' },
            { path: 'workflow.ask_when_unclear', label: '需求不清就问', kind: 'bool' },
            { path: 'workflow.verify_before_claim', label: '完成前先验证', kind: 'bool' },
          ],
        },
        {
          key: 'constraints',
          title: '硬性约束',
          badge: '最高优先级 · 逐条遵守',
          fields: [
            { path: 'constraints', label: '约束', kind: 'list' },
          ],
        },
      ]
    }

    /** Recursively sort object keys so two structurally equal cards compare equal. */
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      }
      return value
    }

    /**
     * Whether a draft differs from what was loaded.
     * @param draft - the edited card.
     * @param original - the loaded card, or null for a new one.
     * @returns true when saving would change something.
     */
    function isDirty(draft, original) {
      if (original === null) return draft !== null
      return JSON.stringify(canonical(draft)) !== JSON.stringify(canonical(original))
    }

    /**
     * Which surface a switcher instance is: a slot that hands over a sessionId
     * switches that session, a slot that does not switches the global default.
     * @param props - the slot's props.
     * @returns the mode.
     */
    function switcherMode(props) {
      return typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? 'session' : 'global'
    }

    /** GET JSON, returning undefined instead of throwing. */
    async function getJson(path) {
      try {
        const res = await fetch(`${ROUTE}${path}`)
        if (!res.ok) return undefined
        return await res.json()
      } catch {
        return undefined
      }
    }

    /**
     * POST JSON.
     * @param path - route path, below the plugin's prefix.
     * @param body - the JSON body.
     * @returns the parsed body; on a non-2xx status the body's own error fields
     *   are kept with `ok: false` forced, so callers can say why. Undefined only
     *   when the request itself failed.
     *
     * The distinction matters: a 409 from `POST /cards` carries `code: 'exists'`
     * and a sentence a user can act on, and collapsing every non-2xx into
     * undefined would leave the editor showing a bare "保存失败" for a problem
     * the host already described. Callers that only care about success test
     * `ok`, which the forced field keeps honest for a body that omitted it.
     */
    async function postJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await res.json().catch(() => ({}))
        if (res.ok) return payload
        return { ok: false, code: payload.code ?? 'http', error: payload.error ?? `HTTP ${res.status}` }
      } catch {
        return undefined
      }
    }

    /** PUT JSON, with the same error shape as postJson. */
    async function putJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await res.json().catch(() => ({}))
        if (res.ok) return payload
        return { ok: false, code: payload.code ?? 'http', error: payload.error ?? `HTTP ${res.status}` }
      } catch {
        return undefined
      }
    }

    /**
     * Which option a switcher shows before the user touches it.
     *
     * Option values are namespaced - `card:<id>`, `none`, `default` - so a card
     * whose id happens to read "none" still gets its own option.
     *
     * The two modes answer different questions. Global mode only ever picks a
     * card, so it shows the current default. Session mode has three answers:
     * a pinned card, no card at all, or follow the default - and the last two
     * are distinct even though both leave `cardId` reporting the default.
     * @param mode - `'session'` or `'global'`.
     * @param cards - the `/cards` payload.
     * @param session - the `/session/<id>` payload, or undefined in global mode.
     * @returns the value to select.
     */
    function initialSelection(mode, cards, session) {
      if (mode === 'global') return cards?.defaultCard ? `card:${cards.defaultCard}` : ''
      if (session === undefined || !Object.hasOwn(session, 'override')) return 'default'
      return session.override === null ? 'none' : `card:${session.override}`
    }

    /**
     * One editable field.
     * @param props.draft - the card.
     * @param props.field - `{ path, label, kind }` from editorGroups().
     * @param props.onChange - called with the next card.
     */
    function EditorField({ draft, field, onChange }) {
      const value = fieldOf(draft, field.path)

      if (field.kind === 'bool') {
        return react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' } },
          react.createElement(Pill, {
            active: value === true,
            onClick: () => onChange(withField(draft, field.path, value !== true)),
          }, value === true ? '已开启' : '已关闭'),
          react.createElement('span', { style: { opacity: 0.75 } }, field.label),
        )
      }

      if (field.kind === 'list') {
        const entries = Array.isArray(value) ? value : []
        const replace = (index, next) => {
          const copy = entries.slice()
          if (next === undefined) copy.splice(index, 1)
          else copy[index] = next
          onChange(withField(draft, field.path, copy))
        }
        return react.createElement(
          'div',
          { style: { margin: '8px 0' } },
          react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, field.label),
          entries.map((entry, index) => react.createElement(
            'div',
            { key: String(index), style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
            // Input renders its own wrapper span around the <input>, and puts
            // any style it is handed on the <input> itself. The flex has to be
            // on a span we own, or the field will not stretch.
            react.createElement('span', { style: { flex: 1, display: 'flex', minWidth: 0 } },
              react.createElement(Input, {
                value: String(entry),
                onChange: (event) => replace(index, event.target.value),
                style: { width: '100%' },
              }),
            ),
            react.createElement(Button, { size: 'sm', onClick: () => replace(index, undefined) }, '删除'),
          )),
          react.createElement(Button, {
            size: 'sm',
            onClick: () => onChange(withField(draft, field.path, [...entries, ''])),
          }, `添加${field.label}`),
        )
      }

      return react.createElement(
        'div',
        { style: { margin: '8px 0' } },
        react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, field.label),
        react.createElement(Input, {
          value: typeof value === 'string' ? value : '',
          onChange: (event) => onChange(withField(draft, field.path, event.target.value)),
        }),
      )
    }

    /**
     * One collapsible group of fields.
     * @param props.group - from editorGroups().
     * @param props.draft - the card.
     * @param props.open - whether the group is expanded.
     * @param props.onToggle - expand/collapse.
     * @param props.onChange - called with the next card.
     */
    function EditorGroup({ group, draft, open, onToggle, onChange }) {
      return react.createElement(
        DisclosureRow,
        {
          icon: react.createElement('span', { 'aria-hidden': true }, '•'),
          title: `${group.title}  ·  ${group.badge}`,
          open,
          expandable: true,
          onToggle,
        },
        group.fields.map(field => react.createElement(EditorField, {
          key: field.path,
          draft,
          field,
          onChange,
        })),
      )
    }

    /** The id row: an input while creating, plain text after that.
     *
     * The id is the file name and the sessions' pointer to it, so renaming an
     * existing card would either orphan its file or leave the sessions that
     * reference it pointing at nothing. A new card has no such history and
     * picks its own id; after that it is fixed.
     */
    function idLockedField(view, onChange) {
      if (view.original !== null) {
        return react.createElement('span', { style: { opacity: 0.75 } }, `id: ${view.draft.id}`)
      }
      return react.createElement(Input, {
        value: view.draft.id ?? '',
        placeholder: 'id（小写字母、数字、连字符）',
        onChange: (event) => onChange(withField(view.draft, 'id', event.target.value)),
      })
    }

    /** The name row. */
    function nameField(view, onChange) {
      return react.createElement('div', { style: { margin: '8px 0' } },
        react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, '名称'),
        react.createElement(Input, {
          value: view.draft.name ?? '',
          onChange: (event) => onChange(withField(view.draft, 'name', event.target.value)),
        }),
      )
    }

    /** Size and D5 advisories.
     *
     * `preview.error` covers both a transport failure and a card the host
     * rejected, because the host puts its reason there in either case.
     */
    function previewPanel(preview) {
      if (preview.status === 'idle') return null
      if (preview.status === 'error') return react.createElement('p', { style: { opacity: 0.8 } }, preview.error)
      if (preview.valid !== true) return react.createElement('p', { style: { opacity: 0.8 } }, preview.error)
      return react.createElement('div', { style: { marginTop: '12px', opacity: 0.85 } },
        react.createElement('div', null, `${preview.tokens} token · ${preview.chars} 字符`),
        (preview.warnings ?? []).map(warning =>
          react.createElement('div', { key: warning.code, style: { marginTop: '4px' } }, `⚠ ${warning.message}`)),
      )
    }

    /**
     * One card being edited.
     *
     * The preview is debounced because it round-trips to the host, which owns
     * the format rules; the client never renders a second time to guess what a
     * card costs. The effect keys on `view.draft`, a fresh object on every edit,
     * so each keystroke clears the pending timer before it fires; the `cancelled`
     * flag then discards a reply that was already in flight when the next edit
     * landed, which is what keeps a slow host from showing one keystroke's size
     * for the next keystroke's card.
     *
     * The draft is editable even while invalid - the host explains what is wrong
     * and the user fixes it in place - but saving waits for `valid`.
     *
     * Saving is not applying: a save only lands on disk, and a session picks the
     * new version up on its next turn. Pushing it into running sessions is the
     * separate, deliberate press in the list row.
     * @param props.view - `{ draft, original }`.
     * @param props.onChange - called with the next draft.
     * @param props.onClose - return to the list, reloading it.
     */
    function CardEditor({ view, onChange, onClose }) {
      const [openGroup, setOpenGroup] = react.useState('identity')
      const [preview, setPreview] = react.useState({ status: 'idle' })
      const [saveError, setSaveError] = react.useState(null)
      const [confirmDiscard, setConfirmDiscard] = react.useState(false)

      const dirty = isDirty(view.draft, view.original)

      react.useEffect(() => {
        let cancelled = false
        const handle = setTimeout(async () => {
          const answer = await postJson('/cards/preview', { card: view.draft })
          if (cancelled) return
          setPreview(answer === undefined
            ? { status: 'error', error: '无法连接宿主' }
            : { status: 'ready', ...answer })
        }, 300)
        return () => { cancelled = true; clearTimeout(handle) }
      }, [view.draft])

      const valid = preview.status === 'ready' && preview.valid === true
      const canSave = valid

      const save = async () => {
        setSaveError(null)
        const isNew = view.original === null
        const path = isNew ? '/cards' : `/cards/${encodeURIComponent(view.draft.id)}`
        const answer = await (isNew ? postJson(path, { card: view.draft }) : putJson(path, { card: view.draft }))
        if (answer === undefined || answer.ok !== true) {
          setSaveError(answer?.error ?? '保存失败')
          return
        }
        onClose()
      }

      // Two clicks, no modal: a confirmation dialog interrupts for a decision
      // the button itself can express, so the first press turns the button into
      // the confirmation and the second discards. The flag is not reset by later
      // edits - once the user has asked to leave, they are one press away from
      // doing so, and re-arming on every keystroke would only add clicks.
      const leave = () => {
        if (!dirty) { onClose(); return }
        if (!confirmDiscard) { setConfirmDiscard(true); return }
        onClose()
      }

      const groups = editorGroups()

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
          react.createElement(Button, { size: 'sm', onClick: leave },
            dirty ? (confirmDiscard ? '确认放弃？' : '放弃修改') : '返回'),
          idLockedField(view, onChange),
          react.createElement(Button, { size: 'sm', onClick: () => { void save() }, disabled: !canSave }, '保存'),
        ),
        saveError === null ? null : react.createElement('p', { style: { opacity: 0.8 } }, saveError),
        nameField(view, onChange),
        groups.map(group => react.createElement(EditorGroup, {
          key: group.key,
          group,
          draft: view.draft,
          open: openGroup === group.key,
          onToggle: () => setOpenGroup(previous => (previous === group.key ? null : group.key)),
          onChange,
        })),
        previewPanel(preview),
      )
    }

    /**
     * The settings page: a card list, and an editor for one card.
     *
     * Only two views exist, so there is no routing, no modal, and no scroll
     * management - the two states are mutually exclusive.
     * @returns {unknown} the section element.
     */
    function CardSettingsSection() {
      const [state, setState] = react.useState({ status: 'loading', cards: [], defaultCard: null })
      const [view, setView] = react.useState({ kind: 'list' })
      const [defaultOpen, setDefaultOpen] = react.useState(false)

      const reload = async () => {
        const payload = await getJson('/cards')
        setState(payload === undefined
          ? { status: 'error', cards: [], defaultCard: null }
          : { status: 'ready', cards: payload.cards ?? [], defaultCard: payload.defaultCard ?? null })
      }

      react.useEffect(() => { void reload() }, [])

      const openEditor = async (cardId) => {
        const payload = cardId === undefined ? undefined : await getJson(`/cards/${encodeURIComponent(cardId)}`)
        if (cardId !== undefined && payload === undefined) return
        const original = payload === undefined ? null : payload.card
        setView({
          kind: 'editor',
          original,
          draft: original === null ? { dshcd: 1, id: '', name: '', description: '' } : structuredClone(original),
        })
      }

      // The editor is built entirely from the primitives package. When a build
      // does not export them, say so - rendering an undefined component throws,
      // and a client component that throws can take the whole client
      // composition with it.
      const missingPrimitives = [Menu, Pill, Input, Button, DisclosureRow]
        .some(component => typeof component !== 'function')

      if (state.status === 'loading') return react.createElement('p', null, '读取卡片库…')
      if (state.status === 'error') return react.createElement('p', null, '无法读取卡片库。')
      if (missingPrimitives) return react.createElement('p', null, '角色卡控件不可用：客户端 UI 原语缺失。')

      if (view.kind === 'editor') {
        return react.createElement(CardEditor, {
          view,
          onChange: (draft) => setView(previous => ({ ...previous, draft })),
          onClose: () => { void reload(); setView({ kind: 'list' }) },
        })
      }

      const chooseDefault = (next) => {
        setState(previous => ({ ...previous, defaultCard: next }))
        void postJson('/default', { cardId: next })
      }

      const rows = state.cards.map(entry => react.createElement(
        'li',
        { key: entry.id, style: { display: 'flex', gap: '12px', padding: '4px 0', alignItems: 'center' } },
        react.createElement(Button, { size: 'sm', onClick: () => { void openEditor(entry.id) } }, entry.name ?? entry.id),
        react.createElement('span', { style: { flex: 1, opacity: 0.7, whiteSpace: 'nowrap' } }, `${entry.tokens} token`),
        entry.sessionsUsing > 0
          ? react.createElement('span', { style: { opacity: 0.7, whiteSpace: 'nowrap', display: 'inline-flex', gap: '6px', alignItems: 'center' } },
              `${entry.sessionsUsing} 个会话正在使用`,
              // Re-applying is opt-in and separate from saving: a live session
              // keeps the card version it started with, so a saved edit reaches
              // it only when someone presses this. The list is reloaded after,
              // because the session count it reports can change.
              react.createElement(Button, {
                size: 'sm',
                onClick: async () => {
                  await postJson(`/cards/${encodeURIComponent(entry.id)}/apply`, {})
                  void reload()
                },
              }, '重新应用'),
            )
          : null,
      ))

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('p', { style: { margin: '0 0 12px', display: 'flex', gap: '12px', alignItems: 'center' } },
          react.createElement('span', null, '默认卡 '),
          react.createElement(Menu, {
            open: defaultOpen,
            items: state.cards.map(entry => ({ id: entry.id, label: entry.name ?? entry.id })),
            selectedId: state.defaultCard,
            onSelect: (id) => { setDefaultOpen(false); chooseDefault(id) },
            onClose: () => setDefaultOpen(false),
            side: 'bottom',
            anchor: react.createElement(Pill, {
              active: defaultOpen,
              onClick: () => setDefaultOpen(!defaultOpen),
            }, state.defaultCard ?? '未设置'),
          }),
          react.createElement(Button, { size: 'sm', onClick: () => { void openEditor(undefined) } }, '新建卡片'),
        ),
        state.cards.length === 0
          ? react.createElement('p', null, '卡片库为空。点「新建卡片」开始。')
          : react.createElement('ul', { style: { margin: 0, padding: 0, listStyle: 'none' } }, rows),
      )
    }

    /**
     * The options a switcher offers, in menu order.
     *
     * One source, two presentations: the popover menu and the fallback select
     * both render this list, so they cannot disagree about what is on offer.
     * `id` is the option value, namespaced as `card:<id>` / `none` / `default`
     * so a card whose id literally reads "none" keeps its own row.
     * @param mode - `'session'` or `'global'`.
     * @param cards - the `/cards` payload.
     * @returns the entries, in the order a menu should show them.
     */
    function switcherEntries(mode, cards) {
      const entries = []
      if (mode === 'session') {
        entries.push({ id: 'none', label: '不使用角色卡' })
        entries.push({ id: 'default', label: '跟随默认' })
      }
      for (const card of cards?.cards ?? []) {
        entries.push({ id: `card:${card.id}`, label: card.name ?? card.id })
      }
      return entries
    }

    /**
     * Styling for the fallback select only; the primary control is a Pill.
     *
     * A native select is chunky by default, which reads as a form control
     * dropped into a row of small icon buttons. Stripping its chrome at least
     * lets it blend instead of announcing itself.
     */
    const CHIP_STYLE = {
      appearance: 'none',
      border: 0,
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      padding: '2px 0',
      cursor: 'pointer',
      maxWidth: '150px',
    }

    /**
     * Card picker for a cell beside the composer.
     *
     * The trigger is a Pill and the popup is the shipped Menu, so the control
     * wears the same clothes as the ones beside it and dsh keeps ownership of
     * anchoring and outside-click dismissal. When those primitives are missing,
     * the same entries render as a plain select - plainer, but still working.
     * @param props - slot props; `sessionId` selects the mode.
     */
    function CardSwitcher(props) {
      const mode = switcherMode(props)
      const sessionId = mode === 'session' ? props.sessionId : undefined
      const [state, setState] = react.useState({ status: 'loading', entries: [], value: '' })
      const [open, setOpen] = react.useState(false)

      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const cards = await getJson('/cards')
          if (cancelled) return
          if (cards === undefined) {
            setState({ status: 'error', entries: [], value: '' })
            return
          }
          const session = sessionId === undefined
            ? undefined
            : await getJson(`/session/${encodeURIComponent(sessionId)}`)
          if (cancelled) return
          setState({
            status: 'ready',
            entries: switcherEntries(mode, cards),
            value: initialSelection(mode, cards, session),
          })
        }
        void load()
        return () => { cancelled = true }
      }, [mode, sessionId])

      // Nothing at all until the host answers: a control that appears and then
      // changes its mind is worse than one that appears settled.
      if (state.status === 'loading') return null
      if (state.status === 'error') {
        return react.createElement('span', { style: { opacity: 0.5, fontSize: '12px' } }, '角色卡')
      }

      const choose = (option) => {
        setOpen(false)
        setState(previous => ({ ...previous, value: option }))
        if (sessionId === undefined) {
          if (option.startsWith('card:')) {
            void postJson('/default', { cardId: option.slice('card:'.length) })
          }
          return
        }
        const sessionPath = `/session/${encodeURIComponent(sessionId)}/card`
        // The body's shape carries the answer: a card id pins, null takes no
        // card at all, and an empty body drops the entry.
        if (option === 'none') void postJson(sessionPath, { cardId: null })
        else if (option === 'default') void postJson(sessionPath, {})
        else void postJson(sessionPath, { cardId: option.slice('card:'.length) })
      }

      if (canUseMenu) {
        const current = state.entries.find(entry => entry.id === state.value)
        return react.createElement(Menu, {
          open,
          items: state.entries,
          selectedId: state.value,
          onSelect: choose,
          onClose: () => setOpen(false),
          // Opening upward is what a control at the bottom of the composer
          // needs, and it is what the shipped permission selector does.
          side: 'top',
          anchor: react.createElement(
            Pill,
            { onClick: () => setOpen(!open), active: open, title: '角色卡' },
            react.createElement('span', null, current?.label ?? '角色卡'),
            Chevron === undefined ? null : react.createElement(
              'span',
              { style: { marginLeft: '4px', display: 'inline-flex', verticalAlign: 'middle' }, 'aria-hidden': true },
              react.createElement(Chevron),
            ),
          ),
        })
      }

      return react.createElement(
        'select',
        {
          style: CHIP_STYLE,
          value: state.value,
          title: '角色卡',
          onChange: (event) => choose(event.target.value),
        },
        state.entries.map(entry =>
          react.createElement('option', { key: entry.id, value: entry.id }, entry.label)),
      )
    }

    /**
     * Activate the browser half.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     */
    function apply(ctx) {
      /**
       * Contribute one cell to a slot, tolerating its absence.
       *
       * `slots.inject` fires only once something declares the key, so a key the
       * running build does not have is silent rather than fatal - a direct
       * `slots.register` against an undeclared slot fails plugin activation
       * instead. Each mount is isolated because a client plugin that throws out
       * of apply() can take the whole client composition with it, which is how
       * plugin entries disappear from the UI entirely.
       * @param key - the slot to contribute to.
       * @param options - registration options; the protocol is id / order / label.
       * @param component - the component to render in that cell.
       */
      const mount = (key, options, component) => {
        try {
          const slots = ctx.get('slots')
          if (slots === undefined || typeof slots.inject !== 'function') return
          slots.inject(key, () => slots.register(options, component))
        } catch {
          // An absent or reshaped slot must degrade to "this surface is
          // missing", never to a broken client.
        }
      }

      // A settings page is the documented way to obtain a whole content area.
      // `id` has to be unique among sections - 'plugins' and 'agent-presets'
      // are shipped ones - and `order` places this entry in the navigation.
      mount('settings.section', {
        name: 'settings.section',
        id: 'character-cards',
        order: 20,
        label: () => '角色卡',
      }, CardSettingsSection)

      // The composer tool row. Confirmed against the live client tree rather
      // than guessed: list cardinality, session scope, replaceRisk none, and an
      // empty occupant list. A list slot under a fresh id is purely additive,
      // so this cannot displace the tools already sitting in that row.
      //
      // Not conversation.input.dock, where the git-graph branch chip lives: that
      // chip renders only for a blank session, and a card switcher that appears
      // only before a session starts cannot do the one thing it is for.
      mount('conversation.input.left', {
        name: 'conversation.input.left',
        id: 'character-cards',
        order: 0,
      }, CardSwitcher)
    }

    return { apply, editorGroups, fieldOf, initialSelection, isDirty, switcherEntries, switcherMode, withField }
  },
})
