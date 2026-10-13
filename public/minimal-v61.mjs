/** Fixed fictional campus messages, without a full-system state or network layer. */
import { BASIC_CATEGORIES, CATEGORIES, LIMITS, measurePacket } from './packet-v6.mjs';

const knownCategories = new Set(CATEGORIES.map(item => item.id));

export function createDefaultMessages() {
  return [
    { id: 'm1', category: 'safety', text: '我平安', selected: true },
    { id: 'm2', category: 'location', text: '我在图书馆', selected: true },
    { id: 'm3', category: 'plan', text: '20:30东门见', selected: true },
    { id: 'm4', category: 'contact', text: '看到请回我', selected: true },
    { id: 'm5', category: 'life', text: '药还没取', selected: false },
    { id: 'm6', category: 'later', text: '伞在图书馆前台', selected: false },
  ];
}

/** Counts category coverage, not semantic adequacy or estimated message value. */
export function coverage(items) {
  if (!Array.isArray(items) || items.some(item => !item || !knownCategories.has(item.category))) {
    throw new TypeError('消息分类无效。');
  }
  const categories = new Set(items.map(item => item.category));
  const covered = BASIC_CATEGORIES.filter(id => categories.has(id));
  const missing = BASIC_CATEGORIES.filter(id => !categories.has(id));
  return { covered, missing, count: covered.length, total: BASIC_CATEGORIES.length };
}

/** Exhaustive <=64 subsets: basic coverage, then message count, then lowest byte cost. */
export function recommendSelection(messages, budget) {
  if (!Number.isInteger(budget) || budget < LIMITS.minBudget || budget > LIMITS.maxBudget
    || (budget - LIMITS.minBudget) % LIMITS.step !== 0) throw new RangeError('消息容量无效。');
  if (!Array.isArray(messages) || messages.length > LIMITS.maxMessages
    || messages.some(item => !item || typeof item.id !== 'string' || item.id.length === 0)
    || new Set(messages.map(item => item.id)).size !== messages.length) {
    throw new TypeError('候选消息列表无效。');
  }
  measurePacket(messages);
  let best = [];
  let bestScore = [-1, 0, -Infinity];
  for (let mask = 1; mask < 2 ** messages.length; mask += 1) {
    const chosen = messages.filter((_, index) => mask & (1 << index));
    const size = measurePacket(chosen);
    if (size > budget) continue;
    const score = [coverage(chosen).count, chosen.length, -size];
    const firstDifference = score.findIndex((value, index) => value !== bestScore[index]);
    if (firstDifference !== -1 && score[firstDifference] > bestScore[firstDifference]) {
      best = chosen.map(item => item.id);
      bestScore = score;
    }
  }
  return best;
}
