export interface GitLabLoaderOptions {
	/**
	 * Base URL of the GitLab instance.
	 * @default 'https://gitlab.com'
	 */
	url?: string;

	/**
	 * Project identifier: either the URL-style path (`group/subgroup/project`)
	 * or the numeric project id.
	 */
	project: string | number;

	/**
	 * Git ref (branch name, tag or commit SHA) to load content from.
	 * Defaults to the repository's default branch.
	 */
	ref?: string;

	/**
	 * Access token used to authenticate against the GitLab API.
	 * A project access token or personal access token with the
	 * `read_api` (or `read_repository`) scope is enough.
	 * Omit for public repositories.
	 */
	token?: string;

	/**
	 * How the token is sent to the API.
	 * - `private-token` — `PRIVATE-TOKEN` header (personal/project access tokens)
	 * - `job-token` — `JOB-TOKEN` header (GitLab CI `CI_JOB_TOKEN`)
	 * - `bearer` — `Authorization: Bearer` header (OAuth tokens)
	 * @default 'private-token'
	 */
	auth?: 'private-token' | 'job-token' | 'bearer';

	/**
	 * Restrict loading to a directory inside the repository, e.g. `docs`.
	 * Entry ids are generated relative to this path.
	 * @default '' (repository root)
	 */
	path?: string;

	/**
	 * Glob patterns (relative to `path`) selecting the files to load.
	 * @default ['**\/*.md', '**\/*.mdx']
	 */
	include?: string[];

	/**
	 * Glob patterns (relative to `path`) excluding files or directories
	 * from rendering, e.g. `['internal/**', '**\/_*.md']`.
	 * @default []
	 */
	exclude?: string[];

	/**
	 * Prefix added to every generated entry id (and therefore URL slug),
	 * e.g. `platform` to serve the docs under `/platform/...`.
	 * @default ''
	 */
	basePath?: string;

	/**
	 * Add a GitLab web URL as `editUrl` in each entry's frontmatter so
	 * Starlight can render an "Edit page" link. Set `false` to disable.
	 * @default true
	 */
	editUrl?: boolean;

	/**
	 * Number of files fetched in parallel.
	 * @default 8
	 */
	concurrency?: number;

	/**
	 * Download assets referenced by relative links in the Markdown (images,
	 * .drawio sources, …) and publish them under
	 * `public/_gitlab-assets/<project>/<blob-sha>/<path>`, rewriting the
	 * links accordingly. Set `false` to leave references untouched.
	 * @default true
	 */
	assets?: boolean;
}

/** Subset of the GitLab repository tree API response. */
export interface GitLabTreeItem {
	id: string;
	name: string;
	type: 'blob' | 'tree' | 'commit';
	path: string;
	mode: string;
}
