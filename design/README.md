# Design reference

`canvas/` holds the sources of the UI concept (design canvas, version 14 of 2026-11-12, the design that counts):
https://claude.ai/artifact/4AeGDBxu8CM7PLvtqP2GWy. One file per screen:

| File | Screen |
|---|---|
| `Main.dc.html` | 1 Overview |
| `Findings.dc.html` | 2 Findings |
| `Player.dc.html` | 3 Players |
| `Market.dc.html` | 4 Markets |
| `Account.dc.html` | 5 Bank accounts |
| `Flow.dc.html` | 6 Money flow |
| `Servers.dc.html` | 7 Saves and servers |
| `Case.dc.html` | 8 Case and report |

They are read to port a screen, not run. How to read one:

- The markup between `<x-dc>` and the `<script>` is the screen. `{{name}}` is a value, `<sc-for list="{{rows}}" as="r">`
  a loop, `<sc-if value="{{flag}}">` a condition. In Svelte these become `{name}`, `{#each rows as r}` and `{#if flag}`.
- The `<script>` at the end computes those values in `renderVals()` from invented data. Chart shapes are built there as
  SVG path strings; that code can be ported as it is.
- The left menu, the top bar and the colours are the same in every file and already exist in `src/ui/app`.
- The canvas shows numbers with commas in its data; the program formats every number through `src/shared/fmt.ts`.
- All names and amounts are invented.

What the canvas shows but version 1 does not build is listed in `.claude/DESIGN_SPEC.md`, section 7.3.
