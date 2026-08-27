# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. Unit tests are colocated as `*.test.js`.

## Build, Test, and Development Commands

- `npm install`: install dependencies and set up Husky.
- `npm run docker:dev`: start the reporting processor for local development on port `3001`.
- `npm run dev`: run the Node watcher in development mode.
- `npm test`: run Vitest with coverage.
- `npm run lint` / `npm run lint:fix`: check or fix JavaScript linting.
- `npm run format:check` / `npm run format`: check or apply Prettier formatting.

## Coding Style & Naming Conventions

Use ES modules and the formatting enforced by Prettier and ESLint. Keep route, service, and helper filenames descriptive and aligned with the API capability they implement.

## Domain Language

Use `CONTEXT.md` as the source of truth for reporting-collector language. Prefer those terms in APIs, docs, tests, and generated changes.

## Developer Addenda

Developers can add their own `AGENTS.local.md` and should be read as an addendum to this file. Keep that file local to your machine and do not commit it.

## Testing Guidelines

Run the narrowest relevant Vitest file first, then `npm test`, `npm run lint`, and `npm run format:check` for broader changes.

## Security & Configuration Tips

Do not commit secrets or real environment values. Local broker files under `compose/` are development fixtures; keep production credentials out of them.

## Executing npm based actions

Do not attempt to execute 'npx' commands directly. Instead, use the provided npm scripts or the Node.js runtime to run your actions.
