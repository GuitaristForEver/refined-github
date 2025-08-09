import './deployments-overview.css';
import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import ClockIcon from 'octicons-plain-react/Clock';
import CheckCircleIcon from 'octicons-plain-react/CheckCircle';
import XCircleIcon from 'octicons-plain-react/XCircle';
import AlertIcon from 'octicons-plain-react/Alert';
import SyncIcon from 'octicons-plain-react/Sync';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {getRepo} from '../github-helpers/index.js';

interface DeploymentStatus {
	state: 'success' | 'error' | 'failure' | 'pending' | 'in_progress' | 'queued' | 'inactive';
	created_at: string;
	environment_url?: string;
	log_url?: string;
}

interface Deployment {
	id: number;
	sha: string;
	ref: string;
	environment: string;
	created_at: string;
	statuses?: DeploymentStatus[];
	latestStatus?: DeploymentStatus;
}

interface Environment {
	name: string;
	deployment?: Deployment;
}

// Cache for deployments data
const cache = new Map<string, {data: Environment[], timestamp: number}>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getStatusIcon(state?: string) {
	switch (state) {
		case 'success':
			return <CheckCircleIcon className="rgh-deployment-status-icon rgh-status-success" />;
		case 'error':
		case 'failure':
			return <XCircleIcon className="rgh-deployment-status-icon rgh-status-error" />;
		case 'pending':
		case 'queued':
			return <ClockIcon className="rgh-deployment-status-icon rgh-status-pending" />;
		case 'in_progress':
			return <SyncIcon className="rgh-deployment-status-icon rgh-status-progress" />;
		case 'inactive':
			return <AlertIcon className="rgh-deployment-status-icon rgh-status-inactive" />;
		default:
			return <AlertIcon className="rgh-deployment-status-icon rgh-status-unknown" />;
	}
}

function timeAgo(dateString: string): string {
	const now = Date.now();
	const date = new Date(dateString).getTime();
	const diff = now - date;
	
	const minutes = Math.floor(diff / (1000 * 60));
	const hours = Math.floor(diff / (1000 * 60 * 60));
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));
	
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

function formatSha(sha?: string): string {
	return sha ? sha.slice(0, 7) : 'unknown';
}

async function fetchDeploymentsGraphQL(): Promise<Environment[]> {
	const {owner, name: repo} = getRepo()!;
	
	try {
		// GraphQL query for deployments - inline like other features
		const query = `
			repository(owner: "${owner}", name: "${repo}") {
				deployments(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
					nodes {
						id
						commit {
							oid
						}
						ref {
							name
						}
						environment
						createdAt
						latestStatus {
							state
							createdAt
							environmentUrl
							logUrl
						}
					}
				}
			}
		`;
		const response = await api.v4(query);
		
		// Check if we got an error response
		if (response?.errors?.length > 0) {
			const error = response.errors[0];
			if (error.message?.includes('SAML') || error.message?.includes('organization')) {
				console.warn('GraphQL deployments query blocked by SAML/organization policy, trying REST API');
				return fetchDeploymentsREST();
			}
			throw new Error(`GraphQL Error: ${error.message}`);
		}
		
		const deployments = response?.repository?.deployments?.nodes || [];
		
		// Group by environment, keeping only the latest deployment per env
		const envMap = new Map<string, Deployment>();
		
		for (const deployment of deployments) {
			const env = deployment.environment;
			if (!envMap.has(env) || new Date(deployment.createdAt) > new Date(envMap.get(env)!.created_at)) {
				envMap.set(env, {
					id: parseInt(deployment.id),
					sha: deployment.commit?.oid || 'unknown',
					ref: deployment.ref?.name || 'unknown',
					environment: env,
					created_at: deployment.createdAt,
					latestStatus: deployment.latestStatus ? {
						state: deployment.latestStatus.state.toLowerCase(),
						created_at: deployment.latestStatus.createdAt,
						environment_url: deployment.latestStatus.environmentUrl,
						log_url: deployment.latestStatus.logUrl,
					} : undefined,
				});
			}
		}
		
		return Array.from(envMap.entries()).map(([name, deployment]) => ({
			name,
			deployment,
		}));
	} catch (error) {
		console.warn('GraphQL deployments query failed, falling back to REST:', error);
		return fetchDeploymentsREST();
	}
}

async function fetchDeploymentsREST(): Promise<Environment[]> {
	const {owner, name: repo} = getRepo()!;
	
	try {
		// Get all deployments - use ignoreHTTPStatus to handle 404s gracefully
		const deploymentsResponse = await api.v3(`repos/${owner}/${repo}/deployments?per_page=100`, {ignoreHTTPStatus: true});
		
		// Handle various HTTP error cases
		if (!deploymentsResponse.ok) {
			if (deploymentsResponse.httpStatus === 404) {
				console.info('Repository not found or no deployments endpoint access');
				return [];
			}
			if (deploymentsResponse.httpStatus === 403) {
				console.info('Access denied to deployments API - may require organization token');
				return [];
			}
			throw new Error(`HTTP ${deploymentsResponse.httpStatus}: ${deploymentsResponse.statusText}`);
		}
		
		const deployments = deploymentsResponse as unknown as any[];
		
		// Group by environment
		const envMap = new Map<string, Deployment>();
		
		for (const deployment of deployments) {
			const env = deployment.environment;
			if (!envMap.has(env) || new Date(deployment.created_at) > new Date(envMap.get(env)!.created_at)) {
				// Fetch latest status for this deployment
				const statuses = await api.v3(`repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=1`) as unknown as any[];
				const latestStatus = statuses[0];
				
				envMap.set(env, {
					id: deployment.id,
					sha: deployment.sha,
					ref: deployment.ref,
					environment: env,
					created_at: deployment.created_at,
					latestStatus,
				});
			}
		}
		
		return Array.from(envMap.entries()).map(([name, deployment]) => ({
			name,
			deployment,
		}));
	} catch (error) {
		console.error('Failed to fetch deployments:', error);
		return [];
	}
}

async function getDeployments(): Promise<Environment[]> {
	const {owner, name: repo} = getRepo()!;
	const cacheKey = `${owner}/${repo}`;
	
	// Check cache
	const cached = cache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
		return cached.data;
	}
	
	// Fetch fresh data
	const environments = await fetchDeploymentsGraphQL();
	
	// Cache the result
	cache.set(cacheKey, {
		data: environments,
		timestamp: Date.now(),
	});
	
	return environments;
}

function createEnvironmentCard(env: Environment): HTMLElement {
	const statusState = env.deployment?.latestStatus?.state || 'unknown';
	const version = env.deployment?.ref || formatSha(env.deployment?.sha) || 'N/A';
	const timeInfo = env.deployment?.latestStatus?.created_at || env.deployment?.created_at;
	
	const card = (
		<div 
			className={`rgh-env-card rgh-status-${statusState}`}
			data-state={statusState}
		>
			<div className="rgh-env-card-header">
				<div className="rgh-env-card-icon">
					{getStatusIcon(statusState)}
				</div>
				<h3 className="rgh-env-card-name">{env.name}</h3>
			</div>
			<div className="rgh-env-card-content">
				<div className="rgh-env-card-version">{version}</div>
				{timeInfo && (
					<div className="rgh-env-card-time">{timeAgo(timeInfo)}</div>
				)}
				{statusState !== 'unknown' && (
					<div className="rgh-env-card-status">
						<span className="rgh-status-text">{statusState}</span>
					</div>
				)}
			</div>
			{env.deployment?.latestStatus?.environment_url && (
				<a 
					className="rgh-env-card-link"
					href={env.deployment.latestStatus.environment_url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`Open ${env.name} environment`}
				>
				</a>
			)}
		</div>
	);
	
	return card;
}

function createEnvironmentPill(env: Environment): HTMLElement {
	const pill = (
		<a 
			className="rgh-env-pill"
			href={env.deployment?.latestStatus?.environment_url || env.deployment?.latestStatus?.log_url || '#'}
			target="_blank"
			rel="noopener noreferrer"
			data-state={env.deployment?.latestStatus?.state || 'unknown'}
		>
			{getStatusIcon(env.deployment?.latestStatus?.state)}
			<strong className="rgh-env-name">{env.name}</strong>
			<span className="rgh-env-meta">
				{formatSha(env.deployment?.sha)}
				{env.deployment?.latestStatus && (
					<>
						 {' • '}
						 <span className="rgh-env-status">{env.deployment.latestStatus.state}</span>
						 {' • '}
						 <span className="rgh-env-time">{timeAgo(env.deployment.latestStatus.created_at)}</span>
					</>
				)}
			</span>
		</a>
	);
	
	return pill;
}

function createDeploymentBar(environments: Environment[]): HTMLElement {
	// Find the primary/production environment
	const prodEnv = environments.find(env => 
		['prod', 'production', 'main', 'master'].includes(env.name.toLowerCase())
	) || environments[0];
	
	const bar = (
		<div className="rgh-deployment-section">
				<div className="rgh-deployment-header">
				<h2 className="rgh-deployment-title">
					Deployments: <span className="rgh-current-env">{prodEnv?.name || 'N/A'}</span>
				</h2>
				<button
					className="rgh-deployment-close btn-octicon"
					type="button"
					title="Hide deployments overview"
					aria-label="Hide deployments overview"
					onClick={event => {
						try {
							sessionStorage.setItem('rgh-hide-deployments-overview', '1');
						} catch {}
						(event.currentTarget as HTMLElement).closest('.rgh-deployment-section')?.remove();
					}}
				>
					×
				</button>
			</div>
			<div className="rgh-deployment-cards">
				{environments.map(env => createEnvironmentCard(env))}
			</div>
		</div>
	);
	
	return bar;
}


function addDeploymentPillsToPR(environments: Environment[]): void {
	const prHead = document.querySelector('.gh-header-meta .commit-sha')?.textContent?.trim();
	if (!prHead) return;
	
	const matchingDeployments = environments.filter(env => 
		env.deployment?.sha.startsWith(prHead)
	);
	
	if (matchingDeployments.length === 0) return;
	
	const container = document.querySelector('.gh-header-meta');
	if (!container) return;
	
	const deploymentInfo = (
		<div className="rgh-pr-deployments">
			<span className="text-muted">Deployed to: </span>
			{matchingDeployments.map(env => (
				<span key={env.name} className={`rgh-pr-deployment-pill rgh-status-${env.deployment?.latestStatus?.state || 'unknown'}`}>
					{getStatusIcon(env.deployment?.latestStatus?.state)}
					{env.name}
				</span>
			))}
		</div>
	);
	
	container.appendChild(deploymentInfo);
}

function addDeploymentPillsToRelease(environments: Environment[]): void {
	const releaseTag = document.querySelector('.release-header .tag-name')?.textContent?.trim();
	if (!releaseTag) return;
	
	const matchingDeployments = environments.filter(env => 
		env.deployment?.ref === releaseTag
	);
	
	if (matchingDeployments.length === 0) return;
	
	const container = document.querySelector('.release-header');
	if (!container) return;
	
	const deploymentInfo = (
		<div className="rgh-release-deployments">
			<h3>Where is this release live?</h3>
			<div className="rgh-deployment-pills">
				{matchingDeployments.map(env => createEnvironmentPill(env))}
			</div>
		</div>
	);
	
	container.appendChild(deploymentInfo);
}

async function renderDeploymentBar(): Promise<void> {
	try {
		// If user hid the overview for this session, skip rendering
		try {
			if (sessionStorage.getItem('rgh-hide-deployments-overview') === '1') {
				return;
			}
		} catch {}
		const environments = await getDeployments();
		
		if (environments.length === 0) {
			return; // No deployments to show
		}
		
		// Find insertion point after repo navigation
		const repoNav = document.querySelector('nav[data-pjax="#js-repo-pjax-container"], .UnderlineNav');
		if (!repoNav) return;
		
		// Remove existing deployment sections
		document.querySelector('.rgh-deployment-bar')?.remove();
		document.querySelector('.rgh-deployment-section')?.remove();
		
		// Create and insert new deployment bar
		const bar = createDeploymentBar(environments);
		repoNav.parentElement?.insertBefore(bar, repoNav.nextSibling);
		
		// Add context pills for PRs and releases
		if (pageDetect.isPR()) {
			addDeploymentPillsToPR(environments);
		} else if (pageDetect.isReleasesOrTags()) {
			addDeploymentPillsToRelease(environments);
		}
	} catch (error) {
		console.error('Failed to render deployment bar:', error);
	}
}

function init(signal: AbortSignal): void {
	// Render on page load and navigation
	renderDeploymentBar();
	
	// Re-render on soft navigation
	document.addEventListener('pjax:end', renderDeploymentBar, {signal});
	document.addEventListener('turbo:load', renderDeploymentBar, {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isRepo,
		pageDetect.isPR,
		pageDetect.isReleasesOrTags,
	],
	init,
});

