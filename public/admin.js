(() => {
  'use strict';
  const { el, api, openModal, buildForm, FORMS, timeAgo } = window.LAM;
  const app = document.getElementById('app');
  const NAMES = ['news', 'gallery', 'events', 'notices', 'directory'];
  const LABEL = { news: 'News', gallery: 'Gallery', events: 'Events', notices: 'Notices', directory: 'Directory' };

  let S = null;            // overview from server
  let tab = 'pending';     // 'pending' | collection | 'settings'
  let filter = 'all';      // status filter inside a collection tab

  /* ---------------- login ---------------- */
  const FB_ERRORS = {
    'auth/popup-closed-by-user': 'The sign-in window was closed. Please try again.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
    'auth/unauthorized-domain': 'This website address is not authorised in Firebase. Add it under Authentication → Settings → Authorized domains.',
    'auth/operation-not-allowed': 'Google sign-in is not switched on in Firebase (Authentication → Sign-in method).',
    'auth/network-request-failed': 'No internet connection. Please try again.',
  };

  async function showLogin(msg) {
    let cfg = { firebase: null, passwordLogin: true };
    try { cfg = await api('/api/auth-config'); } catch { /* fall back to password form */ }
    const err = el('p', { class: 'form-error', role: 'alert', hidden: !msg, text: msg || '' });
    const showErr = (t) => { err.textContent = t; err.hidden = false; };
    const card = el('div', { class: 'card' }, el('h1', { text: 'Lamnian Admin' }), el('p', { text: 'Approve posts and manage the site.' }));

    if (cfg.firebase) {
      const gbtn = el('button', { class: 'btn primary', type: 'button', text: 'Sign in with Google' });
      gbtn.addEventListener('click', async () => {
        err.hidden = true; gbtn.disabled = true; gbtn.textContent = 'Opening Google…';
        try {
          const { googleIdToken } = await import('/firebase-login.js');
          const idToken = await googleIdToken(cfg.firebase);
          await api('/api/admin/firebase-login', { method: 'POST', body: { idToken } });
          load();
        } catch (ex) { showErr(FB_ERRORS[ex.code] || ex.message || 'Sign-in failed.'); }
        finally { gbtn.disabled = false; gbtn.textContent = 'Sign in with Google'; }
      });
      card.append(el('div', { class: 'form' }, gbtn));
    }
    if (cfg.passwordLogin) {
      const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Admin password', 'aria-label': 'Admin password', required: true });
      card.append(el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        try { await api('/api/admin/login', { method: 'POST', body: { password: pw.value } }); load(); }
        catch (ex) { showErr(ex.message); pw.select(); }
      } }, cfg.firebase ? el('p', { class: 'note', text: 'or use the admin password:' }) : null, pw, el('button', { class: 'btn', type: 'submit', text: 'Log in' })));
    }
    card.append(err, el('p', { class: 'fine' }, el('a', { href: '/', text: '← Back to the website' })));
    app.replaceChildren(el('div', { class: 'login' }, card));
  }

  async function load() {
    try { S = await api('/api/admin/overview'); render(); }
    catch (e) { if (e.status === 401) showLogin(); else app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card' }, el('h1', { text: 'Lamnian Admin' }), el('p', { class: 'form-error', text: e.message }), el('button', { class: 'btn primary', text: 'Try again', onclick: load })))); }
  }

  const pendingCount = (n) => S.collections[n].filter((i) => i.status === 'pending').length;
  const totalPending = () => NAMES.reduce((a, n) => a + pendingCount(n), 0);

  /* ---------------- actions ---------------- */
  async function act(name, id, action) {
    try { await api(`/api/admin/item/${name}/${id}/${action}`, { method: 'POST', body: {} }); await load(); }
    catch (e) { alert(e.message); }
  }
  function confirmDelete(name, it) {
    if (confirm('Delete this permanently? This cannot be undone.')) act(name, it.id, 'delete');
  }
  function openEdit(name, it) {
    const def = FORMS[name]; let m;
    const form = buildForm(def, { values: it, allowImage: false, submitLabel: 'Save changes', onSubmit: async (p) => {
      await api(`/api/admin/edit/${name}/${it.id}`, { method: 'POST', body: p }); m.close(); load();
    } });
    m = openModal('Edit ' + def.label.toLowerCase(), form);
  }
  function openCreate(name) {
    const def = FORMS[name]; let m;
    const feat = name === 'news' ? el('label', { class: 'field' }, el('input', { type: 'checkbox', id: 'featNew' }), ' Pin as featured') : null;
    const form = buildForm(def, { submitLabel: 'Publish now', extra: feat, onSubmit: async (p) => {
      if (feat) p.featured = form.querySelector('#featNew').checked;
      await api(`/api/admin/create/${name}`, { method: 'POST', body: p }); m.close(); load();
    } });
    m = openModal('Publish ' + def.label.toLowerCase(), form);
  }

  /* ---------------- item card ---------------- */
  function itemCard(name, it) {
    const def = FORMS[name];
    const titleKey = { news: 'title', gallery: 'caption', events: 'title', notices: 'title', directory: 'name' }[name];
    const skip = new Set([titleKey, 'body', 'description']);
    const kv = def.fields.filter((f) => !skip.has(f.name) && it[f.name]).map((f) => el('span', {}, f.label + ': ', el('b', { text: it[f.name] })));
    const text = it.body || it.description;
    const acts = [];
    if (it.status !== 'approved') acts.push(el('button', { class: 'btn sm primary', text: '✓ Approve', onclick: () => act(name, it.id, 'approve') }));
    if (it.status === 'pending') acts.push(el('button', { class: 'btn sm', text: '✕ Reject', onclick: () => act(name, it.id, 'reject') }));
    if (it.status === 'approved') acts.push(el('button', { class: 'btn sm', text: 'Unpublish', onclick: () => act(name, it.id, 'pending') }));
    if (name === 'news' && it.status === 'approved') acts.push(el('button', { class: 'btn sm', text: it.featured ? '★ Unpin' : '☆ Pin', onclick: () => act(name, it.id, it.featured ? 'unfeature' : 'feature') }));
    acts.push(el('button', { class: 'btn sm', text: 'Edit', onclick: () => openEdit(name, it) }));
    acts.push(el('button', { class: 'btn sm danger', text: 'Delete', onclick: () => confirmDelete(name, it) }));
    return el('article', { class: 'item' + (it.image ? '' : ' no-img') },
      it.image ? el('a', { href: it.image, target: '_blank', rel: 'noopener' }, el('img', { class: 'pic', src: it.image, alt: '', loading: 'lazy' })) : null,
      el('div', {},
        el('div', { class: 'meta' }, el('span', { class: 'st ' + it.status, text: it.status }), el('span', { text: LABEL[name] }), el('span', { text: timeAgo(it.createdAt) }), it.featured ? el('span', { class: 'tag', text: 'Featured' }) : null),
        el('h3', { text: it[titleKey] || '(no title)' }),
        text ? el('p', { text }) : null,
        kv.length ? el('div', { class: 'kv' }, ...kv) : null,
        el('div', { class: 'acts' }, ...acts)));
  }

  /* ---------------- views ---------------- */
  function listView() {
    let rows = [];
    if (tab === 'pending') NAMES.forEach((n) => S.collections[n].filter((i) => i.status === 'pending').forEach((i) => rows.push([n, i])));
    else S.collections[tab].filter((i) => filter === 'all' || i.status === filter).forEach((i) => rows.push([tab, i]));
    rows.sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));

    const bar = el('div', { class: 'a-bar' });
    if (tab !== 'pending') {
      bar.append(el('div', { class: 'filters' }, ...['all', 'pending', 'approved', 'rejected'].map((f) => el('button', { 'aria-pressed': String(filter === f), text: f[0].toUpperCase() + f.slice(1), onclick: () => { filter = f; render(); } }))),
        el('span', { class: 'grow' }), el('button', { class: 'btn primary sm', text: '＋ Publish ' + FORMS[tab].label.toLowerCase(), onclick: () => openCreate(tab) }));
    }
    const list = el('div', { class: 'list' }, ...(rows.length ? rows.map(([n, i]) => itemCard(n, i))
      : [el('div', { class: 'empty' }, el('span', { class: 'big', text: tab === 'pending' ? '🎉' : '📭' }), tab === 'pending' ? 'Nothing is waiting for approval.' : 'Nothing here yet.')]));
    return el('div', {}, bar, list);
  }

  function settingsView() {
    const a = S.settings.alert || { text: '', level: 'info' };
    const text = el('input', { value: a.text, maxlength: 240, placeholder: 'e.g. Road to the bazaar closed due to landslide', id: 'alText' });
    const level = el('select', { id: 'alLevel' }, ...[['info', 'Info (blue)'], ['warning', 'Warning (amber)'], ['danger', 'Danger (red)']].map(([v, l]) => el('option', { value: v, text: l, selected: a.level === v })));
    const saved = el('span', { class: 'note', hidden: true, text: '✓ Saved' });
    const alertForm = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      await api('/api/admin/settings', { method: 'POST', body: { text: text.value, level: level.value } }); saved.hidden = false; setTimeout(() => { saved.hidden = true; }, 2000);
    } },
      el('div', { class: 'row2' }, el('div', { class: 'field' }, el('label', { for: 'alText', text: 'Message' }), text), el('div', { class: 'field' }, el('label', { for: 'alLevel', text: 'Style' }), level)),
      el('div', { class: 'form-actions' }, saved, el('button', { class: 'btn primary', type: 'submit', text: 'Save banner' })),
      el('p', { class: 'note', text: 'Shown at the very top of the website. Leave empty to hide it.' }));

    const ai = S.ai;
    const aiCard = el('div', { class: 'card' }, el('h3', { text: 'AI assistant' }),
      el('div', { class: 'ai-state' }, el('span', { class: 'status-badge' + (ai.connected ? ' on' : ''), text: ai.connected ? 'Connected' : 'Not connected' }), ai.connected ? el('span', { class: 'note', text: `${ai.provider} · ${ai.model}` }) : null),
      ai.connected ? el('p', { class: 'note', text: 'Visitors can chat with the assistant on the website. It already knows today’s weather, latest news and upcoming events.' }) : el('div', {},
        el('p', { class: 'note', text: 'When you are ready: Vercel → your project → Settings → Environment Variables, add these, then redeploy. The chat on the site switches on automatically.' }),
        el('pre', { class: 'code', text: 'LAMNIAN_AI_PROVIDER=anthropic   # or: openai, webhook\nLAMNIAN_AI_KEY=your-api-key\n# optional: LAMNIAN_AI_MODEL=model-name\n# for your own AI server (webhook):\n# LAMNIAN_AI_PROVIDER=webhook\n# LAMNIAN_AI_WEBHOOK=https://your-server/chat' })));

    const backup = el('div', { class: 'card' }, el('h3', { text: 'Backup' }),
      el('p', { class: 'note', text: 'Download all posts and settings as a JSON file (photos are not included; they stay in your Firebase database).' }),
      el('a', { class: 'btn', href: '/api/admin/backup', text: '⬇ Download backup' }));

    return el('div', { class: 'panel' }, el('div', { class: 'card' }, el('h3', { text: 'Site-wide alert banner' }), alertForm), aiCard, backup);
  }

  function render() {
    const top = el('div', { class: 'a-top' }, el('div', { class: 'wrap' }, el('h1', { text: 'Lamnian Admin' }),
      el('div', { class: 'sp' }, el('a', { class: 'btn sm', href: '/', text: 'View site' }),
        el('button', { class: 'btn sm', text: 'Log out', onclick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); showLogin(); } }))));
    const tabs = el('div', { class: 'tabs', role: 'tablist' },
      ...[['pending', 'Waiting for approval', totalPending()], ...NAMES.map((n) => [n, LABEL[n], pendingCount(n)]), ['settings', 'Settings', 0]].map(([k, l, c]) =>
        el('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; filter = 'all'; render(); } }, l, c ? el('span', { class: 'badge', text: String(c) }) : null)));
    app.replaceChildren(top, el('div', { class: 'wrap' }, tabs, tab === 'settings' ? settingsView() : listView()));
    document.title = (totalPending() ? `(${totalPending()}) ` : '') + 'Lamnian Admin';
  }

  load();
})();
