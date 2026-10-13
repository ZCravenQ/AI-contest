// Scene state and accessibility belong to the caller. This module only gives
// already-mounted content a finite entrance/exit, then releases every effect.
export function createSceneMotion({ enabled = () => true } = {}) {
  let generation = 0;
  let currentIncoming = null;
  let currentOutgoing = null;
  const running = new Set();

  function release(animation) {
    running.delete(animation);
    animation.cancel();
  }

  function cancel() {
    generation += 1;
    for (const animation of running) animation.cancel();
    running.clear();
    if (currentOutgoing && currentOutgoing !== currentIncoming) currentOutgoing.hidden = true;
    if (currentIncoming) currentIncoming.hidden = false;
    currentOutgoing = null;
  }

  function transition({ outgoing, incoming, direction = 1, focal = false }) {
    cancel();
    const turn = generation;
    currentIncoming = incoming || null;
    currentOutgoing = outgoing && outgoing !== incoming ? outgoing : null;
    if (!incoming) {
      if (currentOutgoing) currentOutgoing.hidden = true;
      currentOutgoing = null;
      return;
    }
    incoming.hidden = false;
    if (incoming === outgoing) return;

    const outgoingParts = [...(outgoing?.querySelectorAll?.('.motion-part') || [])];
    const incomingParts = [...(incoming.querySelectorAll?.('.motion-part') || [])];
    const parts = [...outgoingParts, ...incomingParts];
    const canAnimate = enabled() && outgoingParts.length && incomingParts.length
      && parts.every(part => typeof part.animate === 'function');
    if (!canAnimate) {
      if (outgoing) outgoing.hidden = true;
      currentOutgoing = null;
      return;
    }

    outgoing.hidden = false;
    const sign = direction < 0 ? -1 : 1;
    const leaving = [];
    const entering = [];
    const start = (part, frames, options, group) => {
      const animation = part.animate(frames, options);
      // Attach a rejection handler immediately: cancel() rejects WAAPI finished.
      const finished = animation.finished.then(() => true, () => false);
      running.add(animation);
      group.push({ animation, finished });
    };

    try {
      outgoingParts.forEach((part, index) => start(part, [
        { opacity: 1, transform: 'translate(0, 0)' },
        { opacity: 0, transform: index === 0 ? 'translateY(-6px)' : `translateX(${-sign * 12}px)` },
      ], { duration: index === 0 ? 150 : 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' }, leaving));

      incomingParts.forEach((part, index) => start(part, [
        { opacity: 0, transform: index === 0 ? 'translateY(6px)' : `translateX(${sign * 12}px)` },
        { opacity: 1, transform: 'translate(0, 0)' },
      ], {
        duration: focal ? 380 : index === 0 ? 340 : 360,
        delay: index === 0 ? 110 : 140,
        easing: 'cubic-bezier(.22,1,.36,1)',
        fill: 'both',
      }, entering));
    } catch {
      // A partial or unsupported WAAPI implementation must never block a page.
      cancel();
      return;
    }

    Promise.all(leaving.map(item => item.finished)).then(() => {
      if (turn !== generation) return;
      outgoing.hidden = true;
      if (currentOutgoing === outgoing) currentOutgoing = null;
      for (const { animation } of leaving) release(animation);
    });
    for (const { animation, finished } of entering) {
      finished.then(() => {
        if (turn === generation) release(animation);
      });
    }
  }

  return { transition, cancel };
}
