import { posix } from 'node:path';

/** A link or image reference found in Markdown/HTML source. */
export interface LinkRef {
	/** Offset of the link target inside the source string. */
	targetStart: number;
	targetEnd: number;
	/** The raw link target as written in the source. */
	target: string;
	/** True for `![...](...)` and `<img src="...">` references. */
	isImage: boolean;
}

const MD_LINK = /(!?\[(?:[^\]\\]|\\.)*\]\(\s*)([^)\s]+)/g;
const HTML_IMG = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(?=["'])/gi;
const HTML_LINK = /(<a\b[^>]*?\bhref\s*=\s*["'])([^"']+)(?=["'])/gi;

/** Find Markdown links/images and HTML `<img>`/`<a>` targets with positions. */
export function findLinkRefs(source: string): LinkRef[] {
	const refs: LinkRef[] = [];
	for (const match of source.matchAll(MD_LINK)) {
		const targetStart = match.index + match[1]!.length;
		refs.push({
			targetStart,
			targetEnd: targetStart + match[2]!.length,
			target: match[2]!,
			isImage: match[1]!.startsWith('!'),
		});
	}
	for (const match of source.matchAll(HTML_IMG)) {
		const targetStart = match.index + match[1]!.length;
		refs.push({
			targetStart,
			targetEnd: targetStart + match[2]!.length,
			target: match[2]!,
			isImage: true,
		});
	}
	for (const match of source.matchAll(HTML_LINK)) {
		const targetStart = match.index + match[1]!.length;
		refs.push({
			targetStart,
			targetEnd: targetStart + match[2]!.length,
			target: match[2]!,
			isImage: false,
		});
	}
	return refs.sort((a, b) => a.targetStart - b.targetStart);
}

const SKIP_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;
const PAGE_EXT = /\.(md|mdx)$/i;
const ANY_EXT = /\.[a-z0-9]+$/i;

export interface ResolvedTarget {
	/** Target path resolved relative to the source file, normalized. */
	resolvedPath: string;
	/** `#fragment` suffix from the original target (empty when none). */
	fragment: string;
	/** Target ends in `.md`/`.mdx`. */
	hasPageExt: boolean;
	/** Target ends in some other extension (`.drawio`, `.png`, …). */
	hasOtherExt: boolean;
}

/**
 * Resolve a link target against the Markdown file's location in the
 * repository. Returns the normalized repo path (plus classification), or
 * undefined when the target should be left untouched: external/absolute/
 * anchor/data URLs, or paths escaping the configured root via `../`.
 */
export function resolveLinkTarget(
	target: string,
	fileRepoPath: string,
	rootPath: string,
): ResolvedTarget | undefined {
	if (SKIP_TARGET.test(target)) return undefined;
	const hashIndex = target.indexOf('#');
	const fragment = hashIndex >= 0 ? target.slice(hashIndex) : '';
	const pathPart = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).split('?')[0]!;
	let clean: string;
	try {
		clean = decodeURIComponent(pathPart);
	} catch {
		return undefined;
	}
	if (!clean) return undefined;
	const resolved = posix.normalize(posix.join(posix.dirname(fileRepoPath), clean));
	// Never escape the publication boundary via ../
	if (resolved.startsWith('../') || resolved === '..') return undefined;
	if (rootPath && resolved !== rootPath && !resolved.startsWith(`${rootPath}/`)) return undefined;
	const lastSegment = resolved.slice(resolved.lastIndexOf('/') + 1);
	return {
		resolvedPath: resolved,
		fragment,
		hasPageExt: PAGE_EXT.test(resolved),
		hasOtherExt: !PAGE_EXT.test(resolved) && ANY_EXT.test(lastSegment),
	};
}

/** Public route URL for a page id (honouring Astro's `base`). */
export function pageUrlOf(base: string | undefined, id: string): string {
	const prefix = (base ?? '/').replace(/\/+$/, '');
	const encoded = id.split('/').map(encodeURIComponent).join('/');
	return `${prefix}/${encoded}/`;
}

/** Repo-path candidates a non-`.md` extensionless link may point to. */
function pageCandidates(resolved: ResolvedTarget): string[] {
	if (resolved.hasPageExt) return [resolved.resolvedPath];
	if (resolved.hasOtherExt) return [];
	// Extensionless link: a sibling page or a directory index.
	const p = resolved.resolvedPath;
	return [`${p}.md`, `${p}.mdx`, `${p}/README.md`, `${p}/index.md`, `${p}/index.mdx`];
}

/** Public URL for a published asset (each path segment encoded). */
export function assetPublicUrl(
	base: string,
	projectSlug: string,
	blobSha: string,
	repoPath: string,
): string {
	const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
	return `${base.replace(/\/+$/, '')}/_gitlab-assets/${projectSlug}/${blobSha}/${encodedPath}`;
}

/** Filesystem-safe identifier for a project ("group/repo" → "group-repo"). */
export function projectSlugOf(project: string | number): string {
	return String(project)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface LinkResolvers {
	/** Map a target repo path to an internal page URL, or undefined. */
	resolvePage: (repoPath: string) => string | undefined;
	/** Download an asset and return its public URL, or undefined. */
	resolveAsset: (repoPath: string) => Promise<string | undefined>;
}

/**
 * Rewrite links and images in Markdown source:
 *  - images and links to non-Markdown files → published asset URLs
 *  - links to other documents → their generated page routes
 *
 * References that resolve to nothing (external, excluded, or missing targets)
 * are left exactly as written.
 */
export async function rewriteLinks(
	source: string,
	fileRepoPath: string,
	rootPath: string,
	{ resolvePage, resolveAsset }: LinkResolvers,
): Promise<string> {
	const refs = findLinkRefs(source);
	if (refs.length === 0) return source;

	let result = '';
	let cursor = 0;
	for (const ref of refs) {
		if (ref.targetStart < cursor) continue; // overlapping match, keep first
		const resolved = resolveLinkTarget(ref.target, fileRepoPath, rootPath);
		if (!resolved) continue;

		let replacement: string | undefined;
		if (ref.isImage) {
			replacement = await resolveAsset(resolved.resolvedPath);
		} else {
			for (const candidate of pageCandidates(resolved)) {
				const pageUrl = resolvePage(candidate);
				if (pageUrl) {
					replacement = pageUrl + resolved.fragment;
					break;
				}
			}
			// Not a page — a linked file (.drawio, .pdf, …) becomes an asset.
			// A `.md` target with no matching page is a broken upstream link and
			// is left untouched rather than published as a downloadable file.
			if (!replacement && !resolved.hasPageExt) {
				replacement = await resolveAsset(resolved.resolvedPath);
			}
		}

		if (!replacement) continue;
		result += source.slice(cursor, ref.targetStart) + replacement;
		cursor = ref.targetEnd;
	}
	return result + source.slice(cursor);
}
