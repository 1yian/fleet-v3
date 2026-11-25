# fleet-v3

If the user asks to set up or onboard Fleet on a machine, read and follow [SETUP.md](SETUP.md).

Read [VISION.md](VISION.md) before designing or changing anything.
If a request conflicts with `VISION.md`, stop and propose an aligned alternative instead of building it.

## Engineering rules

- Prefer deletion and the smallest diff that solves the observed problem; never add speculative validators, defensive guards, or compatibility shims.
- No code comments or docstrings. Express intent through clear names, types, and small functions. Text shown at runtime belongs in explicit CLI help or schema descriptions.
- Validate data at process boundaries (board API payloads, CLI arguments, environment variables, subprocess results); trust typed data inside.

## Verification and docs

- Keep the end-to-end suite small, fast, and focused on core user journeys against real boundaries (the in-memory SQLite Card Server, real git worktrees, real child processes). Do not write unit tests, and do not add a new test for every small change - extend an existing journey or record live verification evidence unless a core contract changed.
- Write documentation in plain, declarative sentences using plain hyphens, never em dashes.
