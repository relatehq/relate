# Relate website

The public OSS homepage for `relatehq.dev`. Plain HTML, CSS, SVG, and a small
progressively enhanced graph interaction. No framework, dependencies, or build.

## Preview

From the repository root:

```sh
python3 -m http.server 3010 --bind 127.0.0.1 --directory apps/www
```

Open <http://localhost:3010>. Select an object in the illustrative graph to see
its source and role. The model and code remain readable without JavaScript.
Motion is a single path trace on load and respects reduced-motion preferences.

## Deploy on Vercel

Create a separate Vercel project using this repository:

- Root directory: `apps/www`
- Framework preset: Other
- Node.js version: 24.x (declared in the website-only `package.json`)
- Build and install commands: disabled (set in `vercel.json`)
- Output directory: `.`
- Domain: `relatehq.dev`; redirect `www.relatehq.dev` to it

The small `package.json` prevents Vercel from inheriting the toolkit workspace's
Node.js requirement. It adds no dependencies or build step.

The documentation remains a separate project at `docs.relatehq.dev`.

## Content and design

- `index.html`: copy, illustrative graph, and a relationship/traversal excerpt.
- `styles.css`: light palette, responsive layout, and reduced-motion support.
- `site.js`: accessible object-selection buttons and their descriptions.
- `assets/`: existing Relate logos and the Viable Systems mark, copied locally
  so the static site can deploy without access to another repository.

The illustration is an example model, not a live runtime or inspector. The code
excerpt assumes registered objects, a relationship, runtime, principal, and an
adopted customer ID; the page links to the full docs and runnable example. Keep
the early-stage notice and preview labels consistent with the main README.

Visual references: [Lithic](https://www.lithic.com/) for generous spacing and
restrained navigation, and [Extend](https://www.extend.ai/) for its light
technical illustration and code-forward layout. No reference assets are used.
The palette is paper `#fafcfd`, ink `#202a34`, muted `#596773`, line `#e1e7ec`,
blue `#346798`, and wash `#edf4fa`. System sans-serif text and monospace code
keep the site self-contained. The business graph is the main visual; the rest of
the page stays quiet.
