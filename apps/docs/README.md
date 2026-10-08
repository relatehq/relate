# Docs

A Fumadocs app for the Relate documentation. Pages are Markdown files in
`content/`, listed in `lib/pages.ts`, which drives the routes, sidebar, and page
metadata. Add a page by creating its file and adding an entry there.

From the repository root:

```sh
pnpm docs:dev    # http://localhost:3100
pnpm docs:build  # static site in apps/docs/out
```

Relative links resolve from the Markdown file, as they do on GitHub. Links to
other content files (`../runtime/actions.md`) become site routes; links to any
other repository file open it on GitHub.

The app uses Fumadocs' default neutral theme, layouts, and Markdown components.
Dev and build commands copy the logos and favicon from `assets/brand` into the
generated public folder.

Run `pnpm --filter @relate/docs typecheck` to check the app's types.
