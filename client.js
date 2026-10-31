window.__ModuleLoader__.load({
  id: 'dsh-cookie-sweep',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BASE = '/dsh-cookie-sweep';

    // 界面文案跟随 app 的文档语言；界面还没同步语言时看浏览器的首选语言。
    const detectZh = (documentLanguage, browserLanguage) => {
      const tag = typeof documentLanguage === 'string' ? documentLanguage : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false;
      const first = Array.isArray(browserLanguage) ? browserLanguage[0] : browserLanguage;
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    };
    const documentLanguage = typeof document !== 'undefined' ? document?.documentElement?.lang : '';
    const browserLanguage = typeof navigator !== 'undefined' ? navigator.languages || navigator.language : '';
    const zh = detectZh(documentLanguage, browserLanguage);

    const COPY = zh
      ? {
          title: 'Cookie 清理',
          intro: '桌面端每次启动都会在网络目录里留下一份登录 cookie 数据库。攒得太多时，每次请求头都会超过 16KB，服务端直接回 431，界面就永远停在 “Web authentication failed”。这个插件在每次启动时把这些文件删掉，登录态本身在 .dsh 里，不受影响。',
          now: '立即清理',
          running: '正在清理…',
          refresh: '刷新状态',
          lastRun: '上次清理',
          never: '本次运行还没清理过',
          triggerStartup: '启动时自动',
          triggerManual: '手动',
          deleted: '已删除',
          absent: '不存在',
          busy: '被占用',
          skipped: '已跳过',
          failed: '失败',
          recreated: '已重建',
          recreatedThenGone: '已清理，未重建',
          roots: '检查的目录',
          noRoots: '没有找到 Electron 网络目录',
          empty: '本次运行还没有清理记录。',
          off: '总开关关着，启动时不会清理，手动清理也不可用。',
          notNow: '手动清理没有生效，请看下面每个文件的说明。',
          busyHint: '文件正被运行中的应用独占：彻底退出 DSH（托盘也退掉）后重新打开，启动清理就会成功。',          sizeHint: '大小',
          load: '状态读取失败',
          retry: '再试一次',
        }
      : {
          title: 'Cookie Sweep',
          intro: 'The desktop app leaves a login-cookie database in its network directory on every launch. Once those cookies pile up, every request header exceeds 16KB, the server answers 431, and the interface is stuck on “Web authentication failed”. This plugin deletes those files on each start; the login state itself lives in .dsh and is untouched.',
          now: 'Clean now',
          running: 'Cleaning…',
          refresh: 'Refresh',
          lastRun: 'Last run',
          never: 'not run yet in this session',
          triggerStartup: 'automatic, at startup',
          triggerManual: 'manual',
          deleted: 'deleted',
          absent: 'absent',
          busy: 'in use',
          skipped: 'skipped',
          failed: 'failed',
          recreated: 'recreated',
          recreatedThenGone: 'cleaned, not recreated',
          roots: 'Directories checked',
          noRoots: 'no Electron network directory found',
          empty: 'Nothing has been cleaned in this session yet.',
          off: 'The master switch is off: nothing is cleaned at startup, and cleaning by hand is disabled.',
          notNow: 'The manual clean did not take effect; the per-file notes below say why.',
          busyHint: 'The file is held by the running app: quit DSH completely (including the tray) and reopen it; the startup clean then succeeds.',
          sizeHint: 'size',
          load: 'Status could not be read',
          retry: 'Try again',
        };

    const bytes = (value) => {
      const size = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    };

    const time = (value) => {
      if (typeof value !== 'string' || value === '') return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    };

    const stateText = (item) => {
      // 后端用连字符拼的复合状态，直接按词拼回去，不会漏掉一种。
      if (item?.state === 'recreated-then-gone') return COPY.recreatedThenGone;
      const map = {
        deleted: COPY.deleted,
        absent: COPY.absent,
        busy: COPY.busy,
        skipped: COPY.skipped,
        failed: COPY.failed,
        recreated: COPY.recreated,
      };
      return map[item?.state] ?? String(item?.state ?? '');
    };

    const tone = (state) => {
      if (state === 'deleted' || state === 'recreated-then-gone') return 'var(--dsw-alias-success, #2f9e5f)';
      if (state === 'recreated') return 'var(--dsw-alias-text-secondary)';
      if (state === 'busy' || state === 'failed') return 'var(--dsw-alias-danger, #c0392b)';
      if (state === 'skipped') return 'var(--dsw-alias-warning, #b8860b)';
      return 'var(--dsw-alias-text-secondary)';
    };

    const section = {
      padding: '4px 0 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      color: 'var(--dsw-alias-text-primary)',
      fontSize: '13px',
      lineHeight: 1.6,
    };
    const intro = { color: 'var(--dsw-alias-text-secondary)', margin: 0, maxWidth: '62ch' };
    const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
    const button = {
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border)',
      background: 'var(--dsw-alias-surface-raised, transparent)',
      color: 'var(--dsw-alias-text-primary)',
      borderRadius: '8px',
      padding: '5px 12px',
      fontSize: '13px',
      cursor: 'pointer',
    };
    const primary = { ...button, background: 'var(--dsw-alias-accent, #247bbf)', color: 'var(--dsw-alias-text-on-accent, #fff)', borderColor: 'transparent' };
    const muted = { color: 'var(--dsw-alias-text-secondary)' };
    const list = { display: 'flex', flexDirection: 'column', gap: '6px', margin: 0, padding: 0, listStyle: 'none' };
    const item = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 10px', borderRadius: '8px', background: 'var(--dsw-alias-surface-sunken, rgba(127,127,127,0.06))' };
    const path = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' };
    const badge = { fontSize: '12px', fontWeight: 600 };

    const readJson = async (response) => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
      }
    };

    function CookieSweep() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [phase, setPhase] = React.useState('idle');
      const [note, setNote] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(`${BASE}/status`, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState(await readJson(response));
          setError(null);
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const clean = async () => {
        setPhase('running');
        setNote(null);
        try {
          const response = await fetch(`${BASE}/clean`, { method: 'POST', cache: 'no-store', credentials: 'same-origin' });
          const body = await readJson(response);
          setState(body);
          setError(null);
          if (body?.status === 'off') setNote(COPY.off);
          else if (body?.status === 'failed') setNote(`${COPY.notNow} ${body.detail ?? ''}`.trim());
          else if (typeof body?.summary?.deleted === 'number') {
            setNote(body.summary.deleted > 0 ? `${COPY.deleted}: ${body.summary.deleted}` : COPY.absent);
          }
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        } finally {
          setPhase('idle');
        }
      };

      const files = Array.isArray(state?.files) ? state.files : [];
      const roots = Array.isArray(state?.roots) ? state.roots : [];
      const lastAt = time(state?.lastAt);
      const trigger = state?.lastTrigger === 'startup' ? COPY.triggerStartup : state?.lastTrigger === 'manual' ? COPY.triggerManual : null;

      return h(
        'section',
        { style: section },
        h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, COPY.title),
        h('p', { style: intro }, COPY.intro),
        h(
          'div',
          { style: row },
          h('button', { type: 'button', style: phase === 'running' || state?.enabled === false ? { ...primary, opacity: 0.55 } : primary, disabled: phase === 'running' || state?.enabled === false, onClick: clean }, phase === 'running' ? COPY.running : COPY.now),
          h('button', { type: 'button', style: button, onClick: () => void load() }, COPY.refresh),
          lastAt === null
            ? h('span', { style: muted }, COPY.never)
            : h('span', { style: muted }, `${COPY.lastRun}: ${lastAt}${trigger === null ? '' : ` · ${trigger}`}`),
        ),
        note === null ? null : h('p', { style: { ...muted, margin: 0 } }, note),
        error === null
          ? null
          : h(
              'p',
              { style: { color: 'var(--dsw-alias-danger, #c0392b)', margin: 0 } },
              `${COPY.load}: ${error}`,
              h('button', { type: 'button', style: { ...button, marginLeft: '8px' }, onClick: () => void load() }, COPY.retry),
            ),
        files.length === 0
          ? h('p', { style: { ...muted, margin: 0 } }, COPY.empty)
          : h(
              'ul',
              { style: list },
              files.map((entry, index) =>
                h(
                  'li',
                  { key: `${entry.path}#${index}`, style: item },
                  h(
                    'div',
                    { style: row },
                    h('span', { style: { ...badge, color: tone(entry.state) } }, stateText(entry)),
                    h('span', { style: path }, entry.path),
                  ),
                  h(
                    'div',
                    { style: { ...muted, fontSize: '12px' } },
                    [entry.size ? `${COPY.sizeHint} ${bytes(entry.size)}` : null, entry.form ? entry.form : null, entry.detail ? entry.detail : null]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                  entry.state === 'busy' ? h('div', { style: { ...muted, fontSize: '12px' } }, COPY.busyHint) : null,
                ),
              ),
            ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { ...muted, fontSize: '12px' } }, COPY.roots),
          roots.length === 0
            ? h('div', { style: muted }, COPY.noRoots)
            : h(
                'ul',
                { style: list },
                roots.map((root) => h('li', { key: root, style: path }, root)),
              ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'settings.cookie-sweep', order: 60, label: COPY.title }, CookieSweep),
        );
      },
    };
  },
});
