# Sokoban solver — make.fun sokoban-solver-01-run-20261121

A push-optimal Sokoban solver, written for the make.fun competition
"Build the best Sokoban solver" (21 November 2026).

## How it works

A generated level is a hallway with one to four independent rooms off it: a
box pushed out of a room's door can never come back, so rooms never interact.
The solver splits the level into rooms, solves each room push-optimally on
its own, and concatenates the rooms' move strings, walking the player between
rooms.

Each room is solved by breadth-first search over pushes, so the first solved
state is push-optimal — the scoring rewards exactly that, since a solution
one push over the optimum earns under half the points. Two prunes keep the
search small without removing any solvable state:

- **Dead squares**: a square from which no sequence of pushes (ignoring the
  other boxes) can ever reach a goal. A box pushed onto one is lost.
- **Frozen 2x2 blocks**: four squares of walls and boxes with a box among
  them off its goal can never move again.

A state is the boxes' squares plus the player's reachable region, named by
its lowest square: every square the player can walk to for free is the same
state. The search is budgeted by states expanded, never by the clock, so two
runs on one set write the same bytes.

Fallbacks, in order: whole-level push search, then a move-based A*, then an
empty solution.

## Results

- Practice set: **1,000,000 / 1,000,000** — all five levels push-optimal
  (13, 16, 29, 47, 60 pushes), in under a second.
- Ten further sets drawn from random seeds with the kit's own generator:
  **1,000,000 on every set** (50/50 levels push-optimal).
- The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` runs on Node 22 (type stripping, erasable syntax only), reads
`/input/<id>/level.txt` for each instance, and writes
`/output/<id>/solution.txt`.

## License

MIT. See LICENSE.
