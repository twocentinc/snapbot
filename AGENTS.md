# AGENTS.md

- Always spell the company name `twocents`.
- Detailed human documentation lives in `twocentinc/oss` under
  `docs/content/docs/snapbot/`, published at https://twocentinc.github.io/oss/docs/snapbot/.
- Keep both READMEs as short landing pages linking to those guides; do not add a parallel docs tree.
- Runtime configuration validation in `src/main.ts` and exported types own the contracts.
  Update the shared docs when behavior changes; document implemented behavior accurately.
- Keep credentials, app data, screenshots, and local capture output out of commits.
- Verify runtime changes with `pnpm test`, `pnpm typecheck`, and
  `pnpm --filter react-native-snapbot typecheck` after `pnpm install --frozen-lockfile`.
- Do not run live captures or app setup as part of automated verification without owner approval.
