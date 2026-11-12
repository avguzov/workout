// Settings: the equipment controls and their changes, the engine probe that guards them, and
// the import summary text. The sweep test makes every single change the Settings UI can make
// from the default profile and checks that the guard either rejects it or that 30 chained
// sessions under the new equipment pass validateSession with every item eligible.

import { test, equal, assert, deepEqual, setReport } from './harness.js';
import { library, clone, simulateLog, dayIso } from './helpers.js';
import {
  equipmentControls, readEquipment, applyEquipmentChange, singleChanges, dayTypes, probeEquipment,
  unfilledSlots, probeMessage, importSummaryText, listText, PROBE_SEEDS,
} from '../js/app/screens/settings.js';
import { generateSession, validateSession, isEligible, makeRng } from '../js/engine/index.js';

const DEFAULT = library.default_equipment;
const NOW = '2026-11-11T12:00:00.000Z';
const byId = new Map(library.movements.map((m) => [m.id, m]));

// Generate, validate, log, and complete `count` sessions after `history`; returns problems.
function chainFrom(equipment, history, count, seedPrefix) {
  const sessions = history.slice();
  const rng = makeRng('log|' + seedPrefix);
  const problems = [];
  for (let i = 0; i < count; i++) {
    const now = dayIso(sessions.length);
    const s = generateSession({ library, equipment, sessions, lengthMin: 50, seed: seedPrefix + '|' + i, now });
    validateSession({ library, equipment, sessions, session: s })
      .forEach((x) => problems.push('#' + i + ' ' + x.rule + ': ' + x.message));
    const tpl = library.slot_templates.find((t) => t.id === s.template_id);
    s.blocks.forEach((b, bi) => b.items.forEach((it) => {
      const mv = byId.get(it.movement_id);
      const roles = tpl.blocks[bi].slots[it.slot].roles;
      if (!mv || !isEligible(mv, roles, equipment)) problems.push('#' + i + ' ' + it.movement_id + ' not eligible for ' + roles.join('/'));
    }));
    sessions.push(simulateLog(s, rng, now.replace('T07', 'T08')));
  }
  return problems;
}

// Six sessions logged on the default profile: the history a user has when changing equipment.
const HISTORY = (() => {
  const out = [];
  const rng = makeRng('log|settings-history');
  for (let i = 0; i < 6; i++) {
    const now = dayIso(i);
    const s = generateSession({ library, equipment: DEFAULT, sessions: out, lengthMin: 50, seed: 'settings-history|' + i, now });
    out.push(simulateLog(s, rng, now.replace('T07', 'T08')));
  }
  return out;
})();

test('settings: the default profile gets a control for every equipment field', () => {
  const controls = equipmentControls(library, DEFAULT);
  deepEqual(controls.map((c) => c.key), [
    'adjustable.present', 'adjustable.max_lb',
    'fixed_pairs_lb.10', 'fixed_pairs_lb.15', 'fixed_pairs_lb.20', 'fixed_pairs_lb.25',
    'bench.present', 'bench.incline', 'pull_up_bar', 'bands',
  ]);
  Object.keys(DEFAULT).forEach((k) => assert(controls.some((c) => c.key.split('.')[0] === k), 'no control for ' + k));
  controls.forEach((c) => {
    equal(c.kind === 'stepper' ? c.value : !!c.value, c.kind === 'stepper' ? DEFAULT.adjustable.max_lb : !!readEquipment(DEFAULT, c.key), c.key);
    equal(c.disabled, false, c.key + ' enabled');
    assert(c.label && !/[—!]/.test(c.label), 'label ' + c.label);
  });
  const stepper = controls.find((c) => c.key === 'adjustable.max_lb');
  const a = DEFAULT.adjustable;
  const steps = [];
  for (let w = a.min_lb; w <= a.max_lb + 1e-9; w += a.step_lb) steps.push(w);
  deepEqual(stepper.options, steps, 'top-weight steps come from the library');
});

test('settings: applyEquipmentChange changes one field and leaves the input alone', () => {
  const before = clone(DEFAULT);
  const off15 = applyEquipmentChange(DEFAULT, 'fixed_pairs_lb.15', false);
  deepEqual(off15.fixed_pairs_lb, [10, 20, 25]);
  deepEqual(applyEquipmentChange(off15, 'fixed_pairs_lb.15', true).fixed_pairs_lb, [10, 15, 20, 25]);
  const noBench = applyEquipmentChange(DEFAULT, 'bench.present', false);
  deepEqual(noBench.bench, { present: false, incline: true });
  equal(applyEquipmentChange(DEFAULT, 'adjustable.max_lb', 45).adjustable.max_lb, 45);
  equal(applyEquipmentChange(DEFAULT, 'pull_up_bar', true).pull_up_bar, true);
  deepEqual(DEFAULT, before, 'library default untouched');
  equal(readEquipment(off15, 'fixed_pairs_lb.15'), false);
  equal(readEquipment(DEFAULT, 'fixed_pairs_lb.15'), true);
  equal(readEquipment(DEFAULT, 'bench.incline'), true);
  // a pair switched off stays listed so it can be switched back on
  assert(equipmentControls(library, off15).some((c) => c.key === 'fixed_pairs_lb.15' && c.value === false), 'pair still listed');
});

test('settings: dependent controls are disabled and not offered as changes', () => {
  const noBench = applyEquipmentChange(DEFAULT, 'bench.present', false);
  const incline = equipmentControls(library, noBench).find((c) => c.key === 'bench.incline');
  equal(incline.disabled, true, 'incline without a bench');
  assert(!singleChanges(library, noBench).some((c) => c.key === 'bench.incline'), 'incline offered');
  const noAdj = applyEquipmentChange(DEFAULT, 'adjustable.present', false);
  equal(equipmentControls(library, noAdj).find((c) => c.key === 'adjustable.max_lb').disabled, true, 'stepper without the adjustable');
  assert(!singleChanges(library, noAdj).some((c) => c.key === 'adjustable.max_lb'), 'stepper offered');
});

test('settings: single changes from the default profile are each switch flipped and the top weight one step down', () => {
  const changes = singleChanges(library, DEFAULT);
  deepEqual(changes, [
    { key: 'adjustable.present', value: false },
    { key: 'adjustable.max_lb', value: 45 },
    { key: 'fixed_pairs_lb.10', value: false },
    { key: 'fixed_pairs_lb.15', value: false },
    { key: 'fixed_pairs_lb.20', value: false },
    { key: 'fixed_pairs_lb.25', value: false },
    { key: 'bench.present', value: false },
    { key: 'bench.incline', value: false },
    { key: 'pull_up_bar', value: true },
    { key: 'bands', value: true },
  ]);
  const at45 = singleChanges(library, applyEquipmentChange(DEFAULT, 'adjustable.max_lb', 45));
  assert(at45.some((c) => c.key === 'adjustable.max_lb' && c.value === 50), 'one step back up');
  assert(at45.some((c) => c.key === 'adjustable.max_lb' && c.value === 40), 'one more step down');
});

test('settings: the probe passes the default profile with ' + (3 * PROBE_SEEDS) + ' runs', () => {
  deepEqual(dayTypes(library).slice().sort(), ['hinge', 'pull', 'push']);
  const t0 = performance.now();
  const p = probeEquipment({ library, equipment: DEFAULT, sessions: HISTORY, lengthMin: 50, autoPickSwaps: true, now: NOW });
  const ms = Math.round(performance.now() - t0);
  assert(p.ok, JSON.stringify(p.failures).slice(0, 400));
  equal(p.runs, 3 * PROBE_SEEDS);
  equal(probeMessage(library, DEFAULT, p), '');
  setReport('settings_probe_ms', ms + ' ms for ' + p.runs + ' probe runs');
});

test('settings: with no dumbbells the probe fails and the message names the slots it cannot fill', () => {
  const none = applyEquipmentChange(applyEquipmentChange(DEFAULT, 'adjustable.present', false), 'fixed_pairs_lb.10', false);
  const eq = ['15', '20', '25'].reduce((e, w) => applyEquipmentChange(e, 'fixed_pairs_lb.' + w, false), none);
  const p = probeEquipment({ library, equipment: eq, sessions: [], lengthMin: 50, now: NOW });
  assert(!p.ok, 'accepted a profile with no dumbbells');
  const msg = probeMessage(library, eq, p);
  const empty = unfilledSlots(library, eq, 'push');
  assert(empty.length > 0, 'no unfilled push slot');
  assert(/^Not changed\./.test(msg) && msg.indexOf(empty[0]) >= 0 && /on push, hinge, and pull days\.$/.test(msg), msg);
  assert(/other slots/.test(msg) && msg.length < 140, 'short: ' + msg);
  assert(!/—|!/.test(msg), 'copy: ' + msg);
});

test('settings: a forced violation makes the probe fail (day order is not counted)', () => {
  // a library copy whose push template asks for a role no movement has
  const lib = clone(library);
  lib.roles.push({ id: 'nothing_fills', label: 'Nothing fills this' });
  lib.slot_templates.filter((t) => t.day_type === 'push').forEach((t) => { t.blocks[0].slots[0].roles = ['nothing_fills']; });
  const p = probeEquipment({ library: lib, equipment: DEFAULT, sessions: [], lengthMin: 50, now: NOW });
  assert(!p.ok && p.failures.length === 1 && p.failures[0].dayType === 'push', JSON.stringify(p.failures).slice(0, 300));
  assert(/Nothing fills this on push days/.test(probeMessage(lib, DEFAULT, p)), probeMessage(lib, DEFAULT, p));
});

test('settings: every single change from the default profile is rejected by the guard or gives 30 valid chained sessions', () => {
  const changes = singleChanges(library, DEFAULT);
  const rejected = [];
  const accepted = [];
  const problems = [];
  const t0 = performance.now();
  changes.forEach((c) => {
    const eq = applyEquipmentChange(DEFAULT, c.key, c.value);
    const name = c.key + '=' + c.value;
    [['history', HISTORY], ['fresh', []]].forEach(([label, history]) => {
      const p = probeEquipment({ library, equipment: eq, sessions: history, lengthMin: 50, autoPickSwaps: true, now: NOW });
      if (!p.ok) {
        rejected.push(name + ' (' + label + ': ' + probeMessage(library, eq, p) + ')');
        return;
      }
      const bad = chainFrom(eq, history, 30, 'sweep|' + name + '|' + label);
      if (bad.length) problems.push(name + ' after ' + label + ': ' + bad.slice(0, 3).join('; '));
      else accepted.push(name + ' (' + label + ')');
    });
  });
  setReport('settings_sweep', {
    ms: Math.round(performance.now() - t0),
    accepted,
    rejected,
  });
  assert(problems.length === 0, problems.slice(0, 4).join(' | '));
  assert(accepted.length > 0, 'nothing accepted');
});

test('settings: import summary text and list joins', () => {
  equal(importSummaryText({ sessions: 12, first_date: '2026-01-05T12:00:00Z', last_date: '2026-01-20T12:00:00Z', exported_at: '2026-11-11T12:00:00Z' }, 3),
    'Backup from Nov 11: 12 sessions (Jan 5 to Jan 20). This phone has 3 sessions.');
  equal(importSummaryText({ sessions: 1, first_date: '2026-02-01T12:00:00Z', last_date: '2026-02-01T12:00:00Z', exported_at: '2026-11-11T12:00:00Z' }, 1),
    'Backup from Nov 11: 1 session (Feb 1 to Feb 1). This phone has 1 session.');
  equal(importSummaryText({ sessions: 0, first_date: null, last_date: null, exported_at: null }, 0),
    'Backup: 0 sessions. This phone has 0 sessions.');
  equal(listText(['a']), 'a');
  equal(listText(['a', 'b']), 'a and b');
  equal(listText(['a', 'b', 'c']), 'a, b, and c');
  equal(listText(['a', 'b', 'c'], 'or'), 'a, b, or c');
});
