// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy: a level is a hallway with one to four independent rooms off it
// (a box pushed out of a room's door can never come back, so rooms never
// interact). Each room is solved push-optimally on its own and the rooms'
// move strings are concatenated, with the player walking between rooms.
// A room search is a breadth-first search over pushes, so the first solved
// state it meets is push-optimal; that is what the scoring rewards, since a
// solution one push over the optimum earns under half the points.
//
// Two prunes keep the search small, and neither removes a solvable state:
//   - dead squares: a square from which no sequence of pushes (ignoring the
//     other boxes) can ever reach a goal. A box pushed onto one is lost.
//   - frozen 2x2 blocks: four squares of walls and boxes with a box among
//     them off its goal can never move again.
// A state is the boxes' squares plus the player's reachable region, named by
// its lowest square: every square the player can walk to for free is the
// same state. The search is budgeted by states expanded, never by the clock,
// so two runs on one set write the same bytes.
//
// Fallbacks, in order: whole-level push search, then a move-based A* (the
// baseline's shape) that may still solve with extra pushes, then empty.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one push search stores before it gives up. */
const ROOM_STATE_LIMIT = 250_000;
/** The most states the whole-level push fallback stores. */
const LEVEL_STATE_LIMIT = 250_000;
/** The most states the move-based A* fallback expands. */
const MOVE_STATE_LIMIT = 400_000;

/** The four steps: [dx, dy, walk letter, push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can stand on and still reach some goal: pull a box back
 * from every goal over open floor, ignoring the other boxes. A box on any
 * other square is dead and can never be pushed onto a goal.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.wall.length);
  const queue: number[] = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the squares the player reaches from `from` around walls and the
 * squares in `occupied`. Marks them in `seen` with `stamp` and returns the
 * lowest square of the region; `stack` is scratch space.
 */
function flood(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const q0 = p - b.w;
    if (!b.wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    const q1 = p + b.w;
    if (!b.wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    const q2 = p - 1;
    if (!b.wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    const q3 = p + 1;
    if (!b.wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes with a box among them off its goal. Such a
 * block never moves again.
 */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if (!(b.wall[a] || occupied[a]) || !(b.wall[c1] || occupied[c1]) || !(b.wall[c2] || occupied[c2]) || !(b.wall[c3] || occupied[c3])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[c1] && !goal[c1]) || (occupied[c2] && !goal[c2]) || (occupied[c3] && !goal[c3])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and `occupied`, in lower-case letters; '' when already there, null when unreachable. */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how: string[] = new Array(b.wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  return p;
}

/**
 * Push-optimal solution of `level`: {pushes, moves} (moves in LURD, an upper
 * letter marks a push), or null when the search gives up or the level has no
 * solution. Breadth-first over pushes, so the first solved state is optimal.
 */
function solvePushes(level: Board, maxStates: number): { pushes: number; moves: string } | null {
  const size = level.wall.length;
  const goal = new Uint8Array(size);
  for (const g of level.goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key: the region's lowest square, then the boxes' squares, as
  // digits in base `size` (exact while size ** (boxes + 1) stays under 2 ** 53).
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const stateBoxes: number[][] = [level.boxes];
  const statePlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, flood(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    flood(level, occupied, statePlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * level.w + dx;
        const t = box + d;
        if (seen[box - d] !== here || level.wall[t] || occupied[t] || !live[t]) continue;
        occupied[box] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, flood(level, occupied, box, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[box] = 1;
        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, stateBoxes.length);
        stateBoxes.push(next!);
        statePlayer.push(box);
        parent.push(head);
        pushFrom.push(box);
        pushTo.push(t);
        if (solved(next!)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = stateBoxes[s];
    const from = pushFrom[s];
    const to = pushTo[s];
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * level.w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done?: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, a goal falls outside every part, or a box starts in the hallway:
 * then the level is no set of rooms.
 */
function roomsOf(level: Board): Room[] | null {
  const live = liveSquares(level);
  const row = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.wall.length);
  for (let i = row * level.w; i < (row + 1) * level.w; i++) {
    if (!level.wall[i] && !live[i]) cut[i] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(level.wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < level.wall.length; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * level.w + dx;
        if (!level.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of level.boxes) rooms[part[b]].boxes.push(b);
  for (const g of level.goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (level.goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Board): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_STATE_LIMIT);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Move-based A* fallback: a state is the player's square and the boxes',
 * every step costs 1, the estimate is each box's Manhattan distance to its
 * nearest goal, summed. It finds the fewest moves, which is not always the
 * fewest pushes, but a solved level beats an unsolved one.
 */
function solveMoves(level: Board, maxExpansions: number): { pushes: number; moves: string } | null {
  const w = level.w;
  const goal = new Uint8Array(level.wall.length);
  for (const g of level.goals) goal[g] = 1;
  const dist = (b: number): number =>
    Math.min(...level.goals.map((g) => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w))));
  const est = (bs: number[]): number => bs.reduce((a, b) => a + dist(b), 0);
  const key = (p: number, bs: number[]): number => {
    let k = p;
    for (const b of bs) k = k * level.wall.length + b;
    return k;
  };
  const sp: number[] = [level.player];
  const sb: number[][] = [level.boxes];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<number, number>([[key(level.player, level.boxes), 0]]);
  const heap: [number, number, number][] = [[est(level.boxes), 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, g, s] = heapPop();
    if (best.get(key(sp[s]!, sb[s]!)) !== s) continue;
    const bs = sb[s]!;
    if (bs.every((b) => goal[b])) {
      let moves = '';
      let pushes = 0;
      for (let t = s; t > 0; t = parent[t]!) {
        moves = step[t] + moves;
        if (step[t] === step[t].toUpperCase()) pushes++;
      }
      return { pushes, moves };
    }
    expanded++;
    const p = sp[s]!;
    for (const [dx, dy, letter, pushLetter] of DIRS) {
      const d = dy * w + dx;
      const q = p + d;
      if (level.wall[q]) continue;
      let nb = bs;
      let move = letter;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (level.wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        move = pushLetter;
      }
      const k = key(q, nb);
      const seen = best.get(k);
      if (seen !== undefined && sg[seen]! <= g + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(g + 1);
      parent.push(s);
      step.push(move);
      best.set(k, t);
      heapPush([g + 1 + est(nb), g + 1, t]);
    }
  }
  return null;
}

/** The moves for a level: rooms first, then the whole-level fallbacks. */
function solve(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushes(level, LEVEL_STATE_LIMIT);
  if (whole !== null) return whole.moves;
  const byMoves = solveMoves(level, MOVE_STATE_LIMIT);
  if (byMoves !== null) return byMoves.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
