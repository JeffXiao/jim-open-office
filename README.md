# Jim Open Office

A small open office suite, built with Univer (Apache-2.0). Published with
GitHub Pages at https://jeffxiao.github.io/jim-open-office/.

## Apps

| App | Folder | Live |
| --- | --- | --- |
| Open Sheet (spreadsheet) | `open-sheet/` | https://jeffxiao.github.io/jim-open-office/open-sheet/ |
| Open Word (word processor) | `open-word/` (not built yet) | — |

The site root is a small landing page (`index.html`) linking to the apps.

## Layout

- `open-sheet/` — the Univer Sheets app (Vite + TypeScript). Its own
  README lives inside that folder.
- `.github/workflows/deploy.yml` — builds `open-sheet/`, then assembles the
  Pages artifact: the landing page at the root and the built sheet under
  `open-sheet/`.

## Develop

```sh
cd open-sheet
npm ci
npm run dev
```

## Deploy

Push to `main`. The workflow builds the sheet and deploys to GitHub Pages
(GitHub Actions source).
