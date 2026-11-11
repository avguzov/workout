// Tiny element builder. h('button', { class: 'x', data: { action: 'start' } }, 'Start')

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'data') {
        Object.keys(v).forEach((dk) => { if (v[dk] != null) el.dataset[dk] = String(v[dk]); });
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  children.flat(Infinity).forEach((c) => {
    if (c == null || c === false || c === '') return;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return el;
}

export function button(label, action, data, extra) {
  return h('button', Object.assign({ type: 'button', data: Object.assign({ action }, data || {}) }, extra || {}), label);
}
