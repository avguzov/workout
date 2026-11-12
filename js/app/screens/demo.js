// Demo sheet: form cues and a video link for one movement, as a bottom sheet over a dimmed
// backdrop. Pure rendering from the library and a movement id, so any screen can reuse it.
// Open buttons use data-action="demo" with data-movement-id; the screen owns the open state.

import { h, button } from '../dom.js';

export function demoSheet(library, movementId) {
  const mv = ((library && library.movements) || []).find((m) => m.id === movementId);
  if (!mv) return null;
  const cues = Array.isArray(mv.cues) ? mv.cues.filter((c) => typeof c === 'string' && c) : [];
  return h('div', {
    class: 'demo-layer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': mv.name + ' form',
    data: { demoSheet: '', movementId: mv.id },
  },
  h('div', { class: 'demo-backdrop', data: { action: 'demo-close' } }),
  h('div', { class: 'demo-panel' },
    h('h2', { class: 'demo-title' }, mv.name),
    cues.length ? h('ul', { class: 'demo-cues' }, cues.map((c) => h('li', { data: { demoCue: '' } }, c))) : null,
    h('div', { class: 'demo-actions' },
      mv.video_url
        ? h('a', {
          class: 'btn primary demo-video',
          href: mv.video_url,
          target: '_blank',
          rel: 'noopener',
          data: { demoVideo: '' },
        }, 'Watch video')
        : null,
      button('Close', 'demo-close', null, { class: 'btn' }))));
}
