# Relate brand assets

The mark is two offset bars; the wordmark is set in
[Inter Display](https://rsms.me/inter/) Medium and outlined, so no font is
needed to render it.

`-light` files are for light backgrounds (near-black `#0A0A0A` ink). `-dark`
files are for dark backgrounds (white ink).

| File                                                 | Use                                                     |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `relate-logo-{light,dark}`                           | Mark and wordmark (primary logo)                        |
| `relate-mark-{light,dark}`                           | Mark only                                               |
| `relate-wordmark-{…}`                                | Wordmark only                                           |
| `relate-icon-{light,dark}`                           | Mark on a rounded square tile                           |
| `favicon.svg`                                        | Transparent mark that follows the browser colour scheme |
| `favicon.ico`, `png/favicon-*`                       | 16/32/48 px fallbacks (dark tile)                       |
| `png/apple-touch-icon.png`, `png/icon-{192,512}.png` | App and web-manifest icons                              |
| `png/relate-avatar-*.png`                            | 500 × 500 GitHub organisation or profile avatar         |
| `png/relate-social-*.png`                            | 1280 × 640 GitHub repository social preview             |

In Markdown, switch with the colour scheme:

```html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="assets/brand/relate-logo-dark.svg"
  />
  <img alt="Relate" src="assets/brand/relate-logo-light.svg" height="48" />
</picture>
```

In HTML:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```
