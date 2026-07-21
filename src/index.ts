import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Loader, LoaderContext } from 'astro/loaders';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { assetPublicUrl, pageUrlOf, projectSlugOf, rewriteLinks } from './assets.js';
import { GitLabClient, withConcurrency } from './gitlab.js';
import type { GitLabLoaderOptions, GitLabTreeItem } from './types.js';

export type { GitLabLoaderOptions };
export { GitLabApiError } from './gitlab.js';

const LOADER_VERSION = '0.3.0';
const DEFAULT_INCLUDE = ['**/*.md', '**/*.mdx'];
const META_KEY = 'starlight-gitlab-loader:last-sync';
const OWNED_IDS_KEY = 'starlight-gitlab-loader:owned-ids';
const ASSETS_KEY = 'starlight-gitlab-loader:assets';

/** repo path → blob sha of every asset published during the last sync. */
type AssetManifest = Record<string, string>;

/**
 * Loads Markdown content from a GitLab repository through the REST API,
 * so a docs site can render documentation that lives in another repo.
 *
 * ```ts
 * // src/content.config.ts
 * import { defineCollection } from 'astro:content';
 * import { docsSchema } from '@astrojs/starlight/schema';
 * import { gitlabLoader } from 'starlight-gitlab-loader';
 *
 * export const collections = {
 *   docs: defineCollection({
 *     loader: gitlabLoader({
 *       project: 'my-group/my-project',
 *       path: 'docs',
 *       token: process.env.GITLAB_TOKEN,
 *       exclude: ['internal/**'],
 *     }),
 *     schema: docsSchema(),
 *   }),
 * };
 * ```
 */
export function gitlabLoader(options: GitLabLoaderOptions): Loader {
	return {
		name: 'astro-datasource-gitlab',
		load: (context) => load(options, context),
	};
}

async function load(options: GitLabLoaderOptions, context: LoaderContext): Promise<void> {
	const { store, meta, logger, parseData, generateDigest, renderMarkdown, config } = context;
	const client = new GitLabClient(options);
	const rootPath = trimSlashes(options.path ?? '');

	// Starlight's auto-generated sidebar derives the page tree from
	// `entry.filePath`, so remote entries get a virtual path inside the docs
	// collection directory (e.g. src/content/docs/<id>.md).
	const collectionDir = path
		.join(path.relative(fileURLToPath(config.root), fileURLToPath(config.srcDir)), 'content/docs')
		.split(path.sep)
		.join('/');
	// LOADER_VERSION is part of the digest so upgrades invalidate cached syncs.
	const configDigest = generateDigest(
		JSON.stringify({ ...options, token: undefined, v: LOADER_VERSION }),
	);

	const { sha, ref } = await client.resolveRef(options.ref);

	const projectSlug = projectSlugOf(options.project);
	const assetsEnabled = options.assets !== false;
	const assetsRoot = path.join(fileURLToPath(config.publicDir), '_gitlab-assets', projectSlug);
	const assetManifest: AssetManifest = readJson(meta.get(ASSETS_KEY)) ?? {};

	/** Re-download manifest assets that vanished from publicDir (e.g. clean checkout). */
	const restoreAssets = async () => {
		const missing = Object.entries(assetManifest).filter(
			([repoPath, blobSha]) => !fs.existsSync(assetDiskPath(assetsRoot, blobSha, repoPath)),
		);
		await withConcurrency(
			missing.map(([repoPath, blobSha]) => async () => {
				const data = await client.fetchBlobBinary(blobSha);
				writeAssetFile(assetDiskPath(assetsRoot, blobSha, repoPath), data);
			}),
			options.concurrency ?? 8,
		);
		if (missing.length > 0) logger.info(`Restored ${missing.length} missing asset(s)`);
	};

	const lastSync = readJson<{ sha: string; configDigest: string }>(meta.get(META_KEY));
	const previouslyOwnedIds = readJson<string[]>(meta.get(OWNED_IDS_KEY)) ?? [];
	// The whole sync can only be skipped when every previously loaded entry is
	// still in the store — other loaders sharing the collection (e.g. glob /
	// docsLoader) sweep entries whose files don't exist on disk.
	if (
		lastSync &&
		lastSync.sha === sha &&
		lastSync.configDigest === configDigest &&
		previouslyOwnedIds.length > 0 &&
		previouslyOwnedIds.every((id) => store.has(id))
	) {
		if (assetsEnabled) await restoreAssets();
		logger.info(`Content is up to date (${shortSha(sha)}), skipping sync`);
		return;
	}
	const configChanged = lastSync?.configDigest !== configDigest;

	logger.info(`Syncing ${options.project}@${ref} (${shortSha(sha)})${rootPath ? ` /${rootPath}` : ''}`);

	const tree = await client.listTree(sha, rootPath);
	const files = filterTree(tree, rootPath, options);

	const previouslyOwned = new Set(previouslyOwnedIds);
	const ownedIds = new Set<string>();
	let fetched = 0;
	let reused = 0;
	let assetsPublished = 0;

	// Blob shas of everything in the tree, for resolving relative asset links.
	const blobByPath = new Map(tree.filter((i) => i.type === 'blob').map((i) => [i.path, i.id]));
	const assetJobs = new Map<string, Promise<string | undefined>>();

	/**
	 * Download an asset once (content-addressed by blob sha, so unchanged
	 * files already on disk are never refetched) and return its public URL.
	 */
	const ensureAsset = (repoPath: string): Promise<string | undefined> => {
		let job = assetJobs.get(repoPath);
		if (!job) {
			job = (async () => {
				const blobSha = blobByPath.get(repoPath);
				if (!blobSha) return undefined;
				const diskPath = assetDiskPath(assetsRoot, blobSha, repoPath);
				if (!fs.existsSync(diskPath)) {
					writeAssetFile(diskPath, await client.fetchBlobBinary(blobSha));
				}
				assetManifest[repoPath] = blobSha;
				assetsPublished++;
				return assetPublicUrl(config.base ?? '/', projectSlug, blobSha, repoPath);
			})().catch((error) => {
				logger.warn(`Failed to load asset ${repoPath}: ${error}`);
				return undefined;
			});
			assetJobs.set(repoPath, job);
		}
		return job;
	};

	// Entries reused below skip the asset scan, so bring back any manifest
	// files missing from publicDir first.
	if (assetsEnabled) await restoreAssets();

	// Plan all entries upfront so directory structure is known: an index page
	// of a directory with no other content collapses into a plain sidebar item
	// instead of a one-child group.
	const planned = files.map((file) => ({ file, ...entryId(file.path, rootPath, options.basePath) }));
	const dirsWithContent = new Set<string>();
	// Repo path (lowercased) → generated page URL, so relative links between
	// documents can be rewritten to their real slugified routes.
	const pageUrlByRepoPath = new Map<string, string>();
	for (const { file, id } of planned) {
		pageUrlByRepoPath.set(file.path.toLowerCase(), pageUrlOf(config.base, id));
		const segments = id.split('/');
		for (let i = 1; i < segments.length; i++) {
			dirsWithContent.add(segments.slice(0, i).join('/'));
		}
	}
	const resolvePage = (repoPath: string) => pageUrlByRepoPath.get(repoPath.toLowerCase());

	const tasks = planned.map(({ file, id, isIndex }) => async () => {
		if (ownedIds.has(id)) {
			logger.warn(`Duplicate slug "${id}" generated for ${file.path}, keeping the first entry`);
			return;
		}
		ownedIds.add(id);
		const nestedIndex = isIndex && dirsWithContent.has(id);

		// The blob SHA identifies the content, so unchanged files are not refetched.
		const existing = store.get(id);
		if (!configChanged && existing?.digest === file.id && previouslyOwned.has(id)) {
			reused++;
			return;
		}

		const raw = await client.fetchBlob(file.id);
		fetched++;

		const { frontmatter, content } = splitFrontmatter(raw);
		let { title, body } = deriveTitle(frontmatter, content, file.name);

		// Rewrite links before rendering: inter-document links become their
		// real slugified routes, and relative images / linked files (.drawio,
		// …) are downloaded into publicDir. Page rewriting always runs; asset
		// downloading is gated by the `assets` option.
		body = await rewriteLinks(body, file.path, rootPath, {
			resolvePage,
			resolveAsset: assetsEnabled ? ensureAsset : async () => undefined,
		});

		const editUrl =
			options.editUrl === false ? undefined : client.webEditUrl(options.project, ref, file.path);

		const data = await parseData({
			id,
			data: {
				...frontmatter,
				title,
				...(editUrl && frontmatter.editUrl === undefined ? { editUrl } : {}),
			},
		});

		const rendered = await renderMarkdown(body);

		store.set({
			id,
			data,
			body,
			digest: file.id,
			filePath: virtualFilePath(collectionDir, id, nestedIndex),
			rendered,
		});
	});

	await withConcurrency(tasks, options.concurrency ?? 8);

	// Remove entries this loader created earlier that no longer exist upstream.
	// Other loaders may share the store, so only ids owned by us are swept.
	let deleted = 0;
	for (const id of previouslyOwned) {
		if (!ownedIds.has(id)) {
			store.delete(id);
			deleted++;
		}
	}

	meta.set(OWNED_IDS_KEY, JSON.stringify([...ownedIds]));
	meta.set(ASSETS_KEY, JSON.stringify(assetManifest));
	meta.set(META_KEY, JSON.stringify({ sha, configDigest }));

	logger.info(
		`Synced ${ownedIds.size} page(s): ${fetched} fetched, ${reused} unchanged${deleted ? `, ${deleted} removed` : ''}${assetsPublished ? `, ${assetsPublished} asset(s)` : ''}`,
	);
}

function filterTree(
	tree: GitLabTreeItem[],
	rootPath: string,
	options: GitLabLoaderOptions,
): GitLabTreeItem[] {
	const include = picomatch(options.include ?? DEFAULT_INCLUDE, { nocase: true });
	const exclude = options.exclude?.length ? picomatch(options.exclude, { nocase: true }) : () => false;
	const prefix = rootPath ? `${rootPath}/` : '';

	return tree.filter((item) => {
		if (item.type !== 'blob') return false;
		if (!item.path.startsWith(prefix)) return false;
		const relative = item.path.slice(prefix.length);
		return include(relative) && !exclude(relative);
	});
}

/** Derive a URL-friendly entry id from a repository file path. */
function entryId(
	filePath: string,
	rootPath: string,
	basePath = '',
): { id: string; isIndex: boolean } {
	const prefix = rootPath ? `${rootPath}/` : '';
	const relative = filePath.slice(prefix.length).replace(/\.(md|mdx)$/i, '');
	let segments = relative.split('/').map(slugifySegment);
	// README.md / index.md become the index page of their directory.
	const last = segments[segments.length - 1];
	const isIndex = last === 'readme' || last === 'index';
	if (isIndex) segments = segments.slice(0, -1);
	const base = trimSlashes(basePath).split('/').filter(Boolean).map(slugifySegment);
	const id = [...base, ...segments].filter(Boolean).join('/');
	return { id: id || 'index', isIndex };
}

/**
 * Virtual file path inside the docs collection, used by Starlight to build
 * the auto-generated sidebar. Directory segments are humanized so group
 * labels read "Additional ca cert bundle" instead of the raw slug; the leaf
 * keeps the slug (its label comes from the page title).
 */
function virtualFilePath(collectionDir: string, id: string, nestedIndex: boolean): string {
	const segments = id.split('/');
	const leaf = segments.pop()!;
	const dirs = segments.map(humanizeSegment);
	const parts = nestedIndex ? [...dirs, humanizeSegment(leaf), 'index'] : [...dirs, leaf];
	return `${collectionDir}/${parts.join('/')}.md`;
}

function humanizeSegment(segment: string): string {
	const words = segment.replace(/[-_]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function slugifySegment(segment: string): string {
	return segment
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9а-яё]+/gi, '-')
		.replace(/^-+|-+$/g, '');
}

interface SplitResult {
	frontmatter: Record<string, unknown>;
	content: string;
}

function splitFrontmatter(raw: string): SplitResult {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (!match) return { frontmatter: {}, content: raw };
	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1]!);
	} catch {
		return { frontmatter: {}, content: raw };
	}
	if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
		frontmatter = {};
	}
	return { frontmatter: frontmatter as Record<string, unknown>, content: raw.slice(match[0].length) };
}

/**
 * Starlight requires a `title` and renders it as the page heading, so when
 * frontmatter has no title the first `# H1` is promoted (and removed from the
 * body to avoid a duplicate heading), falling back to the file name.
 */
function deriveTitle(
	frontmatter: Record<string, unknown>,
	content: string,
	fileName: string,
): { title: string; body: string } {
	if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
		return { title: frontmatter.title, body: content };
	}
	const h1 = /^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(content);
	if (h1) {
		const title = h1[1]!.replace(/[*_`]/g, '').trim();
		const body = content.slice(0, h1.index) + content.slice(h1.index + h1[0].length);
		return { title, body: body.replace(/^\s*\n/, '') };
	}
	const fromName = fileName.replace(/\.(md|mdx)$/i, '').replace(/[-_]+/g, ' ').trim();
	return { title: fromName.charAt(0).toUpperCase() + fromName.slice(1), body: content };
}

function assetDiskPath(assetsRoot: string, blobSha: string, repoPath: string): string {
	return path.join(assetsRoot, blobSha, ...repoPath.split('/'));
}

function writeAssetFile(diskPath: string, data: Uint8Array): void {
	fs.mkdirSync(path.dirname(diskPath), { recursive: true });
	fs.writeFileSync(diskPath, data);
}

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

function readJson<T>(value: string | undefined): T | undefined {
	if (!value) return undefined;
	try {
		return JSON.parse(value) as T;
	} catch {
		return undefined;
	}
}
