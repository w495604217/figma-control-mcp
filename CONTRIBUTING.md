# Contributing

Thank you for contributing to Figma Control MCP.

This project is still in beta and is trying to solve a difficult boundary: making Figma programmable in a way that feels closer to Pencil MCP while staying honest about current Figma platform limits.

## Contribution Priorities

We welcome improvements in any area, but the highest-value contributions today are:

1. deterministic library and component discovery
2. path-based selectors and query stability
3. transactional queue semantics and rollback
4. instance override and variant support
5. session resilience and reconnect logic
6. tracing, replay, and execution diagnostics
7. cross-platform desktop fallback support

## Before You Start

Please read:

- [README.md](README.md)
- [ROADMAP.md](ROADMAP.md)
- [docs/PRD.md](docs/PRD.md)
- [docs/TECH_SPEC.md](docs/TECH_SPEC.md)

## Development Setup

```bash
npm install
npm test
npm run build
npm run typecheck:plugin
npm run build:plugin
```

Run the local bridge:

```bash
npm run dev
```

## Pull Request Guidelines

- keep changes scoped
- prefer structured, deterministic interfaces over ad hoc heuristics
- add or update tests for behavior changes
- document platform assumptions clearly
- do not hide Figma API limitations behind misleading abstractions

## Coding Guidelines

- TypeScript first
- no hidden magic constants when they can be named
- keep bridge, runtime, and desktop fallback boundaries explicit
- prefer small composable modules over large mixed-control files
- preserve the hybrid philosophy: plugin/runtime first, desktop fallback second

## Testing Expectations

At minimum, please run:

```bash
npm test
npm run build
```

If your change touches the plugin worker:

```bash
npm run typecheck:plugin
npm run build:plugin
```

## Issues and Proposals

When filing an issue or opening a design proposal, include:

- the user-level workflow
- the exact Figma limitation or failure mode
- the desired deterministic behavior
- whether the fix belongs in the plugin runtime, bridge, talk-to-figma integration, or desktop fallback layer
