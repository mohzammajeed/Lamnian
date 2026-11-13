/* Shared helpers for the public site and the admin panel. */
window.LAM = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Tiny DOM builder. Text is always inserted as text (never HTML) → no XSS.
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lamnian' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Request failed (' + res.status + ')'), { status: res.status });
    return data;
  }

  // Shrink photos in the browser before upload (saves data for phone users).
  async function resizeImage(file, maxDim = 1280, quality = 0.78) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Please choose a JPG, PNG or WebP photo.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not read that photo.')); i.src = url; });
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    } finally { URL.revokeObjectURL(url); }
  }

  /* ---------------- modal ---------------- */
  function openModal(title, content, { wide = false } = {}) {
    const prev = document.activeElement;
    const close = () => { overlay.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
      el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'modal-head' }, el('h3', { text: title }), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, text: '✕' })),
        el('div', { class: 'modal-body' }, content)));
    document.body.append(overlay);
    document.body.classList.add('no-scroll');
    document.addEventListener('keydown', onKey);
    const first = overlay.querySelector('input,textarea,select,button.primary');
    if (first) first.focus();
    return { close };
  }

  /* ---------------- forms ---------------- */
  const NOTICE_CATS = ['Lost & Found', 'For Sale', 'Jobs', 'Help Needed', 'Rides & Transport', 'Announcement'];
  const DIR_CATS = ['Shop', 'Food', 'Health', 'Education', 'Transport', 'Repairs & Services', 'Stay', 'Government', 'Other'];

  const FORMS = {
    news: { label: 'News', icon: '📰', blurb: 'Share something happening in our area.', image: 'optional', imageLabel: 'Photo (optional)', fields: [
      { name: 'title', label: 'Headline', max: 120, req: true, placeholder: 'What happened?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 5000, req: true, placeholder: 'Write the full story here…' },
      { name: 'author', label: 'Your name', max: 60, placeholder: 'Optional — shown with the story' },
      { name: 'contact', label: 'Phone / WhatsApp', max: 80, placeholder: 'Optional — only the admin sees this', hint: 'So the admin can verify the news.' }] },
    gallery: { label: 'Photo', icon: '📷', blurb: 'Show everyone the beauty of Lamnian.', image: 'required', imageLabel: 'Your photo', fields: [
      { name: 'caption', label: 'Caption', max: 160, placeholder: 'Sunrise over the ridge…' },
      { name: 'place', label: 'Place', max: 80, placeholder: 'Where was it taken?' },
      { name: 'author', label: 'Photographer', max: 60, placeholder: 'Your name' },
      { name: 'contact', label: 'Phone / WhatsApp', max: 80, placeholder: 'Optional — only the admin sees this' }] },
    events: { label: 'Event', icon: '📅', blurb: 'Weddings, jalsas, matches, meetings, markets.', image: 'optional', imageLabel: 'Poster (optional)', fields: [
      { name: 'title', label: 'Event name', max: 120, req: true },
      { name: 'date', label: 'Date', type: 'date', req: true },
      { name: 'time', label: 'Time', max: 20, placeholder: 'e.g. 4:00 PM' },
      { name: 'place', label: 'Place', max: 100, req: true },
      { name: 'description', label: 'Details', type: 'textarea', max: 1500 },
      { name: 'author', label: 'Organiser', max: 60 },
      { name: 'contact', label: 'Contact number', max: 80, placeholder: 'Shown publicly' }] },
    notices: { label: 'Notice', icon: '📌', blurb: 'Lost & found, things for sale, jobs, help needed.', image: 'optional', imageLabel: 'Photo (optional)', fields: [
      { name: 'category', label: 'Type', type: 'select', options: NOTICE_CATS, req: true },
      { name: 'title', label: 'Title', max: 120, req: true },
      { name: 'body', label: 'Details', type: 'textarea', max: 1500, req: true },
      { name: 'phone', label: 'Phone number', max: 30, placeholder: 'Shown publicly if you add it' },
      { name: 'author', label: 'Your name', max: 60 }] },
    directory: { label: 'Business / Service', icon: '🏪', blurb: 'Add a shop, clinic, school, workshop or guest house.', image: 'optional', imageLabel: 'Photo (optional)', fields: [
      { name: 'name', label: 'Name', max: 100, req: true },
      { name: 'category', label: 'Category', type: 'select', options: DIR_CATS, req: true },
      { name: 'phone', label: 'Phone', max: 40 },
      { name: 'address', label: 'Where is it?', max: 140, placeholder: 'Bazaar, mohalla, landmark…' },
      { name: 'hours', label: 'Opening hours', max: 80, placeholder: 'e.g. 8 am – 9 pm' },
      { name: 'description', label: 'About', type: 'textarea', max: 300 }] },
  };

  /**
   * buildForm(def, {values, allowImage, submitLabel, onSubmit(payload)})
   * onSubmit may throw; the message is shown under the form.
   */
  function buildForm(def, { values = {}, allowImage = true, submitLabel = 'Submit', onSubmit, extra } = {}) {
    let imageData = null;
    const err = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = el('form', { class: 'form', novalidate: true });

    for (const f of def.fields) {
      const id = 'f_' + f.name + Math.random().toString(36).slice(2, 6);
      let input;
      if (f.type === 'textarea') input = el('textarea', { id, name: f.name, rows: 5, maxlength: f.max, placeholder: f.placeholder || '', required: !!f.req });
      else if (f.type === 'select') input = el('select', { id, name: f.name, required: !!f.req }, el('option', { value: '', text: 'Choose…' }), f.options.map((o) => el('option', { value: o, text: o })));
      else input = el('input', { id, name: f.name, type: f.type || 'text', maxlength: f.max, placeholder: f.placeholder || '', required: !!f.req });
      if (values[f.name] != null) input.value = values[f.name];
      form.append(el('div', { class: 'field' },
        el('label', { for: id }, f.label, f.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null),
        input, f.hint ? el('small', { text: f.hint }) : null));
    }

    if (extra) form.append(extra);

    if (allowImage && def.image) {
      const preview = el('div', { class: 'img-preview', hidden: true });
      const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', id: 'img' + Math.random().toString(36).slice(2, 6) });
      file.addEventListener('change', async () => {
        err.hidden = true;
        const f = file.files[0];
        if (!f) { imageData = null; preview.hidden = true; return; }
        try {
          imageData = await resizeImage(f);
          preview.hidden = false; preview.replaceChildren(el('img', { src: imageData, alt: 'Selected photo preview' }));
        } catch (e) { imageData = null; preview.hidden = true; file.value = ''; err.textContent = e.message; err.hidden = false; }
      });
      form.append(el('div', { class: 'field' }, el('label', { for: file.id }, def.imageLabel || 'Photo', def.image === 'required' ? el('span', { class: 'req', text: ' *' }) : null), file, preview));
    }

    // Honeypot: real people never see or fill this.
    form.append(el('div', { class: 'hp', 'aria-hidden': 'true' }, el('label', {}, 'Website', el('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }))));
    const btn = el('button', { class: 'btn primary', type: 'submit', text: submitLabel });
    form.append(err, el('div', { class: 'form-actions' }, btn));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const payload = {};
      for (const f of def.fields) payload[f.name] = form.elements[f.name].value;
      payload.website = form.elements.website.value;
      if (allowImage && def.image) {
        if (def.image === 'required' && !imageData) { err.textContent = 'Please choose a photo.'; err.hidden = false; return; }
        payload.image = imageData;
      }
      for (const f of def.fields) if (f.req && !String(payload[f.name]).trim()) { err.textContent = `Please fill in “${f.label}”.`; err.hidden = false; form.elements[f.name].focus(); return; }
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Please wait…';
      try { await onSubmit(payload); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
      finally { btn.disabled = false; btn.textContent = old; }
    });
    return form;
  }

  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  return { $, $$, el, api, resizeImage, openModal, buildForm, FORMS, timeAgo };
})();
