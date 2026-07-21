import type { GitLabLoaderOptions, GitLabTreeItem } from './types.js';

export class GitLabApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly url: string,
		detail?: string,
	) {
		super(`GitLab API request failed with ${status} for ${url}${detail ? `: ${detail}` : ''}`);
		this.name = 'GitLabApiError';
	}
}

export class GitLabClient {
	readonly baseUrl: string;
	readonly projectId: string;
	readonly #headers: Record<string, string>;

	constructor(options: Pick<GitLabLoaderOptions, 'url' | 'project' | 'token' | 'auth'>) {
		this.baseUrl = (options.url ?? 'https://gitlab.com').replace(/\/+$/, '');
		this.projectId = encodeURIComponent(String(options.project));
		this.#headers = {};
		if (options.token) {
			switch (options.auth ?? 'private-token') {
				case 'private-token':
					this.#headers['PRIVATE-TOKEN'] = options.token;
					break;
				case 'job-token':
					this.#headers['JOB-TOKEN'] = options.token;
					break;
				case 'bearer':
					this.#headers['Authorization'] = `Bearer ${options.token}`;
					break;
			}
		}
	}

	get projectApiUrl(): string {
		return `${this.baseUrl}/api/v4/projects/${this.projectId}`;
	}

	async #fetch(url: string): Promise<Response> {
		const response = await fetch(url, { headers: this.#headers });
		if (!response.ok) {
			let detail: string | undefined;
			try {
				detail = (await response.text()).slice(0, 200);
			} catch {
				// ignore body read errors, the status is the signal
			}
			throw new GitLabApiError(response.status, url, detail);
		}
		return response;
	}

	/** Resolve a ref name to a commit SHA. Empty ref resolves the default branch. */
	async resolveRef(ref?: string): Promise<{ sha: string; ref: string }> {
		if (!ref) {
			const response = await this.#fetch(this.projectApiUrl);
			const project = (await response.json()) as { default_branch: string };
			ref = project.default_branch;
		}
		const url = `${this.projectApiUrl}/repository/commits/${encodeURIComponent(ref)}`;
		const response = await this.#fetch(url);
		const commit = (await response.json()) as { id: string };
		return { sha: commit.id, ref };
	}

	/** List all blobs under `path` at `ref`, following pagination. */
	async listTree(ref: string, path: string): Promise<GitLabTreeItem[]> {
		const items: GitLabTreeItem[] = [];
		let page: string | null = '1';
		while (page) {
			const url = new URL(`${this.projectApiUrl}/repository/tree`);
			url.searchParams.set('ref', ref);
			url.searchParams.set('recursive', 'true');
			url.searchParams.set('per_page', '100');
			url.searchParams.set('page', page);
			if (path) url.searchParams.set('path', path);
			const response = await this.#fetch(url.href);
			items.push(...((await response.json()) as GitLabTreeItem[]));
			page = response.headers.get('x-next-page') || null;
		}
		return items;
	}

	/** Fetch raw file content by blob SHA (immutable, cache-friendly). */
	async fetchBlob(blobSha: string): Promise<string> {
		const url = `${this.projectApiUrl}/repository/blobs/${blobSha}/raw`;
		const response = await this.#fetch(url);
		return await response.text();
	}

	/** Fetch raw binary content (images and other assets) by blob SHA. */
	async fetchBlobBinary(blobSha: string): Promise<Uint8Array> {
		const url = `${this.projectApiUrl}/repository/blobs/${blobSha}/raw`;
		const response = await this.#fetch(url);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Web URL for editing a file on GitLab, for Starlight's "Edit page" link. */
	webEditUrl(project: string | number, ref: string, filePath: string): string | undefined {
		// Web URLs need the path-style project id; a numeric id has no web route.
		if (typeof project === 'number' || /^\d+$/.test(String(project))) return undefined;
		const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
		return `${this.baseUrl}/${project}/-/edit/${encodeURIComponent(ref)}/${encodedPath}`;
	}
}

/** Run `tasks` with at most `limit` in flight at once. */
export async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	async function worker() {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]!();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}
