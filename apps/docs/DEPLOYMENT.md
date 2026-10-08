# Vercel deployment

The docs and homepage are separate Vercel projects connected to the same
`relatehq/relate` repository. Each app has its own `vercel.json`.

| Setting          | Documentation                    | Homepage       |
| ---------------- | -------------------------------- | -------------- |
| Root directory   | `apps/docs`                      | `apps/www`     |
| Framework preset | Next.js                          | Other          |
| Install command  | `pnpm install --frozen-lockfile` | Skipped        |
| Build command    | `pnpm build`                     | Skipped        |
| Output directory | `.next`                          | `.`            |
| Domain           | `docs.relatehq.dev`              | `relatehq.dev` |

For the docs project, enable **Include source files outside of the Root
Directory in the Build Step**. The workspace lockfile and shared brand assets
live at the repository root. Use the workspace's pinned pnpm version.

The docs build copies shared brand assets before running Next.js. Its
`output: 'export'` configuration generates a static site in `out/` for other
static hosts. Vercel's Next.js adapter reads build metadata from `.next/` and
handles that export itself; its Output Directory must remain `.next`, not `out`.

Add `www.relatehq.dev` to the homepage project as a redirect to `relatehq.dev`.
Use each Vercel project's exact DNS values in GoDaddy. Changing one project's
domain does not configure the other project.

To check the docs build locally, run `pnpm docs:build` from the repository root.
For the homepage preview command, see [its README](../www/README.md).
