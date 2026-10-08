# Docs

A single-page Fumadocs app at `/`, rendered directly from the repository's root
`README.md`. Edit that file to update the documentation; there is no separate
content copy. Relative README links open their files on GitHub.

From the repository root:

```sh
pnpm docs:dev    # http://localhost:3100
pnpm docs:build  # static site in apps/docs/out
```

The app uses Fumadocs' default neutral theme, layouts, and Markdown components.
The existing Relate logos follow its light/dark theme. Dev and build commands
copy the logos and favicon from `assets/brand` into the generated public folder.

Run `pnpm --filter @relate/docs typecheck` to check the app's types.
