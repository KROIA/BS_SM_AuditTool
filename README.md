# Audit Tool

Offline investigation tool for Minecraft worlds that run the BankSystem and StockMarket mods. It loads copies of
one or several saves of a server network, finds signs of exploits and cheating, follows the money and produces a
report. It never writes into a save.

State: milestone M0 (foundation). The program starts, opens saves and lists what it finds. The other screens follow
milestone by milestone; see `.claude/PLAN.md`. What the tool does is specified in `.claude/DESIGN_SPEC.md`.

## Run it

Needs Node 24 or newer.

```
npm install
npm start                 build and open the program
npm test                  engine and number-format tests
npm run test:ui           build, start the program with invented saves, check the screens
npm run check             type check of everything
```

`npm run test:ui` writes screenshots to `test-results/`.

## How it is put together

| Folder | What it holds |
|---|---|
| `src/shared` | The list of calls the screens may make, and the one number and time format (`1'532.05`) |
| `src/engine` | Reads saves and calculates. Runs in a background process, uses only what Node brings |
| `src/main` | The window process: window, folder dialog, passes calls to the engine |
| `src/ui` | The screens (Svelte). They have no file or system access |
| `test/fixtures` | Builds invented saves for the tests |
| `local/` | Real saves and reports. Ignored by git, never commit anything from there |

Rules for code: TypeScript without enums and namespaces (the tests run the `.ts` files directly), imports with the
`.ts` ending, amounts and ids as `bigint` from reading to display, every number on a screen through `src/shared/fmt.ts`.
