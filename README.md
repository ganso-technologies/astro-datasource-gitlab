# @gansotech/astro-datasource-gitlab

Astro [content loader](https://docs.astro.build/en/reference/content-loader-reference/)
that fetches Markdown documentation from a **GitLab repository** through the
REST API. Built for [Starlight](https://starlight.astro.build/) documentation
sites, works with any Astro 5+ content collection.

Publish docs that live in a (private) GitLab repo on a standalone docs portal —
no git submodules, no copying, just a read-only access token.

## Features

- 🦊 Loads `.md`/`.mdx` files via the GitLab REST API (gitlab.com or self-hosted)
- 🔑 Auth with a personal/project access token, `CI_JOB_TOKEN` or OAuth bearer token
- 🧭 Works with Starlight's auto-generated sidebar (virtual `filePath` per entry)
- 🏷️ Derives page titles: frontmatter `title` → first `# H1` (removed from body) → file name
- 🙈 `include`/`exclude` glob patterns to control what gets published
- ⚡ Incremental syncs: unchanged files (same blob SHA) are not refetched,
  removed files are deleted from the store
- 🖼️ Downloads relatively-linked assets (images, `.drawio` sources, …) into
  `public/_gitlab-assets/` and rewrites the links — content-addressed by blob
  SHA, so unchanged assets are never refetched
- 🔗 Rewrites relative links between documents to their real generated routes,
  so cross-references keep working after slugifying and `basePath` prefixing
- ✏️ Adds an `editUrl` pointing at GitLab for Starlight's "Edit page" link

## Installation

```sh
npm install @gansotech/astro-datasource-gitlab
```

## Usage

```ts
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { gitlabLoader } from '@gansotech/astro-datasource-gitlab';

export const collections = {
  docs: defineCollection({
    loader: gitlabLoader({
      project: 'my-group/my-project',
      path: 'docs',
      token: process.env.GITLAB_TOKEN,
      exclude: ['internal/**', '**/_*.md'],
      basePath: 'platform',
    }),
    schema: docsSchema(),
  }),
};
```

To combine remote content with local pages, delegate to both loaders:

```ts
const combinedLoader = {
  name: 'my-docs',
  load: async (context) => {
    await docsLoader().load(context);
    await gitlabLoader({ project: 'my-group/my-project' }).load(context);
  },
};
```

## Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `project` | `string \| number` | — (required) | Project path (`group/subgroup/project`) or numeric id |
| `url` | `string` | `https://gitlab.com` | Base URL of the GitLab instance |
| `ref` | `string` | default branch | Branch, tag or commit SHA to load from |
| `token` | `string` | — | Access token with `read_api` + `read_repository` scopes; omit for public repos |
| `auth` | `'private-token' \| 'job-token' \| 'bearer'` | `'private-token'` | How the token is sent (PAT, `CI_JOB_TOKEN`, OAuth) |
| `path` | `string` | `''` | Directory inside the repo to load, e.g. `docs` |
| `include` | `string[]` | `['**/*.md', '**/*.mdx']` | Globs (relative to `path`) selecting files |
| `exclude` | `string[]` | `[]` | Globs excluding files/directories from publication |
| `basePath` | `string` | `''` | Prefix for generated slugs, e.g. `platform` → `/platform/...` |
| `editUrl` | `boolean` | `true` | Add a GitLab web edit URL to each page's frontmatter |
| `concurrency` | `number` | `8` | Parallel file downloads |
| `assets` | `boolean` | `true` | Download relatively-linked assets and rewrite their URLs |

## How entries are generated

- `docs/adr/0001-use-postgres.md` → slug `adr/0001-use-postgres`
  (plus `basePath` prefix if set)
- `README.md` / `index.md` become the index page of their directory
- Page title: frontmatter `title`, else the first `# H1` (which is then
  removed from the body so Starlight doesn't render it twice), else the
  humanized file name
- Mermaid/remark/rehype: content is rendered through your project's Markdown
  pipeline, so integrations like `astro-mermaid` apply to remote content too

## Caching

The loader stores the synced commit SHA and a config digest. On subsequent
builds:

- same commit + same config → sync is skipped entirely
- changed commit → only files with changed blob SHAs are refetched
- files deleted upstream (or newly excluded) are removed from the collection

Note: when combined with Starlight's `docsLoader()` in one collection, the
glob loader sweeps entries whose files don't exist on disk on every run, so
remote entries are refetched on each build. The loader detects this and
resyncs automatically.

## Assets

Relative references found in Markdown images (`![…](…)`), HTML `<img>` tags
and plain Markdown links to non-Markdown files (e.g. `.drawio`, `.json`) are
downloaded through the API and published as:

```
public/_gitlab-assets/<project-slug>/<blob-sha>/<path-in-repo>
```

The links are rewritten to the public URL before rendering. External
(`http(s)://`), absolute (`/…`), `data:`, `mailto:` and anchor (`#…`) targets
are left untouched, as are links to other Markdown pages. Paths escaping the
configured `path` root via `../` are refused. Add
`public/_gitlab-assets/` to `.gitignore`; old blob-sha versions accumulate
there over time and can be deleted at any moment — the loader restores
whatever the current pages need on the next run.

## Internal links

Relative links between documents are rewritten to the routes this loader
generates. A link written against the repository layout resolves to the
slugified, `basePath`-prefixed page URL:

- `[Race condition](withdrawal-....md)` → `/platform/payments/withdrawal-.../`
- `[Providers](../provider-game-integration/README.md)` → `/platform/provider-game-integration/`
- extensionless links to a directory resolve to its `README.md`/`index.md` page
- `#fragment` anchors are preserved

External, absolute, `mailto:` and same-page `#anchor` links are left untouched.
A link whose target file does not exist (or was excluded) is left exactly as
written, so broken upstream links stay visible rather than pointing at an
invented route.

## Limitations

- Links to files that are excluded by `exclude` (or missing upstream) are not
  rewritten and will 404, the same as in the source repository.

## License

MIT
