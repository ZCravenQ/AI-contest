import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneMotion } from '../public/scene-motion-v6.mjs';

// Controlled WAAPI model: finished stays pending until finish() or cancel().
// This verifies timing ownership, not browser appearance or layout.
class Part {
  constructor(name) { this.name = name; this.animations = []; }
  animate(frames, options) {
    let resolve;
    let reject;
    let settled = false;
    const animation = {
      frames, options, cancelled: false,
      finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
      finish() { if (!settled) { settled = true; resolve(); } },
      cancel() {
        this.cancelled = true;
        if (!settled) { settled = true; reject(new Error('Animation cancelled')); }
      },
    };
    this.animations.push(animation);
    return animation;
  }
}

function makeScene(name, count = 2) {
  const parts = Array.from({ length: count }, (_, index) => new Part(`${name}-${index}`));
  return {
    name, parts, hidden: true, inert: true, textContent: `${name} 的原始正文`,
    querySelectorAll(selector) { assert.equal(selector, '.motion-part'); return parts; },
  };
}
const all = scene => scene.parts.flatMap(part => part.animations);
const latest = scene => scene.parts.map(part => part.animations.at(-1));
async function settle() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }

test('only parts animate, with bounded delayed entrances and no whole-scene scaling', async () => {
  const a = makeScene('A');
  const b = makeScene('B', 4);
  const motion = createSceneMotion({ enabled: () => true });
  motion.transition({ outgoing: a, incoming: b, direction: -1, focal: true });
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, false);
  assert.equal(a.inert, true, 'Accessibility remains owned by the caller');
  assert.equal(b.inert, true);
  for (const animation of [...all(a), ...all(b)]) {
    assert.doesNotMatch(JSON.stringify(animation.frames), /scale|blur/);
    assert.ok(animation.options.duration + (animation.options.delay || 0) <= 540);
  }
  assert.equal(latest(a)[0].options.duration, 150);
  assert.equal(latest(a)[1].options.duration, 170);
  assert.equal(latest(b)[0].frames[0].transform, 'translateY(6px)');
  assert.equal(latest(b)[1].frames[0].transform, 'translateX(-12px)');
  assert.equal(latest(b)[0].options.delay, 110);
  assert.equal(latest(b)[1].options.delay, 140);
  latest(a)[0].finish();
  await settle();
  assert.equal(a.hidden, false, 'Do not reveal an early-finished exit layer');
  assert.equal(latest(a)[0].cancelled, false);
  latest(a)[1].finish();
  await settle();
  assert.equal(a.hidden, true);
  assert.ok(all(a).every(animation => animation.cancelled));
  for (const animation of latest(b)) animation.finish();
  await settle();
  assert.ok(all(b).every(animation => animation.cancelled), 'Finished fill effects are released');
  assert.equal(b.hidden, false);
});

test('A → B → A → B ignores rejected and fulfilled callbacks from older turns', async () => {
  const a = makeScene('A');
  const b = makeScene('B');
  const motion = createSceneMotion({ enabled: () => true });
  motion.transition({ outgoing: a, incoming: b });
  // Queue a fulfilled old exit before cancellation, without flushing callbacks.
  for (const animation of latest(a)) animation.finish();
  motion.transition({ outgoing: b, incoming: a, direction: -1 });
  motion.transition({ outgoing: a, incoming: b });
  await settle();
  assert.equal(a.hidden, false, 'Stale callbacks cannot hide the newest outgoing layer early');
  assert.equal(b.hidden, false, 'Stale callbacks cannot hide the newest incoming scene');
  const newestExit = latest(a);
  const newestEntrance = latest(b);
  assert.ok(newestExit.every(animation => !animation.cancelled));
  assert.ok(newestEntrance.every(animation => !animation.cancelled));
  for (const animation of newestExit) animation.finish();
  await settle();
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, false);
  for (const animation of newestEntrance) animation.finish();
  await settle();
  motion.cancel();
});

test('cancel rejects pending effects safely and immediately keeps only the latest incoming scene', async () => {
  const a = makeScene('A');
  const b = makeScene('B');
  const motion = createSceneMotion();
  motion.transition({ outgoing: a, incoming: b });
  motion.cancel();
  motion.cancel();
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, false);
  assert.ok([...all(a), ...all(b)].every(animation => animation.cancelled));
  await settle();
  assert.equal(b.hidden, false);
});

test('reduced motion cancels an active transition and instantly shows the requested scene', async () => {
  let enabled = true;
  const a = makeScene('A');
  const b = makeScene('B');
  const motion = createSceneMotion({ enabled: () => enabled });
  motion.transition({ outgoing: a, incoming: b });
  enabled = false;
  const count = all(a).length + all(b).length;
  motion.transition({ outgoing: b, incoming: a, direction: -1 });
  await settle();
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, true);
  assert.equal(all(a).length + all(b).length, count);
  assert.ok([...all(a), ...all(b)].every(animation => animation.cancelled));
});

test('missing animation support, missing parts and partial WAAPI failures fall back without hiding incoming', async () => {
  for (const kind of ['no-animate', 'no-parts', 'throws']) {
    const a = makeScene('A');
    const b = makeScene('B', kind === 'no-parts' ? 0 : 2);
    if (kind === 'no-animate') b.parts[1].animate = undefined;
    if (kind === 'throws') b.parts[1].animate = () => { throw new Error('Unsupported animation'); };
    const motion = createSceneMotion();
    assert.doesNotThrow(() => motion.transition({ outgoing: a, incoming: b }));
    await settle();
    assert.equal(a.hidden, true, kind);
    assert.equal(b.hidden, false, kind);
    assert.ok([...all(a), ...all(b)].every(animation => animation.cancelled), kind);
  }
});

test('same-node transitions preserve the actual message object and create no replacement animation', async () => {
  const a = makeScene('A');
  const b = makeScene('B');
  const originalParts = b.parts.slice();
  const originalText = b.textContent;
  const motion = createSceneMotion();
  motion.transition({ outgoing: a, incoming: b });
  const count = all(b).length;
  motion.transition({ outgoing: b, incoming: b });
  await settle();
  assert.equal(b.hidden, false);
  assert.equal(a.hidden, true);
  assert.equal(all(b).length, count);
  assert.equal(b.textContent, originalText);
  assert.ok(originalParts.every((part, index) => b.parts[index] === part));
  assert.ok(all(b).every(animation => animation.cancelled));
});
