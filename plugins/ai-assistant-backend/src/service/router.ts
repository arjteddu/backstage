/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import express from 'express';
import Router from 'express-promise-router';
import Anthropic from '@anthropic-ai/sdk';
import { CatalogClient } from '@backstage/catalog-client';
import {
  AuthService,
  RootConfigService,
  DiscoveryService,
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';

export interface RouterOptions {
  config: RootConfigService;
  discovery: DiscoveryService;
  auth: AuthService;
  httpAuth: HttpAuthService;
  logger: LoggerService;
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert AI assistant embedded in a Backstage developer portal. You have LIVE access to the software catalog and can answer any question about it.

## What you can do
- Explore **all entity kinds**: Component, API, System, Domain, Group, User, Resource, Template, Location
- Filter by **any field**: kind, type, lifecycle, owner, system, domain, tags, annotations, labels
- **Full-text search** across names, titles, descriptions, tags, and annotations
- Traverse **entity relationships**: dependencies, dependents, members, system membership, API providers/consumers
- Get **aggregations and statistics**: counts by owner, type, lifecycle, tags
- Read **complete API definitions**: OpenAPI, AsyncAPI, GraphQL, gRPC specs

## How to behave
- Always use tools to fetch LIVE data — never guess or make up entity names, owners, or metadata
- When a user asks a fuzzy question ("find the payment service"), use \`query_catalog\` with a text search first, then \`get_entity_details\` for specifics
- For relationship questions ("what depends on X?"), use \`get_entity_relations\` after resolving the entity ref
- For aggregation questions ("how many components per owner?"), use \`get_catalog_facets\`
- For ownership questions ("what does team X own?"), first search for the group with \`query_catalog\`, get its exact ref, then use \`query_catalog\` with owner filter
- Chain tool calls as needed — you can call multiple tools in sequence
- Format responses clearly with markdown: use **bold** for entity names, bullet lists for collections, and tables for comparisons

## Entity reference format
Entity refs use the format \`kind:namespace/name\`, e.g.:
- \`component:default/my-service\`
- \`api:default/payments-api\`
- \`group:default/platform-team\`
- \`user:default/jane.doe\`

## Field filters
When using filter parameters, valid field paths include:
- \`kind\` — Component, API, System, Domain, Group, User, Resource, Template
- \`metadata.name\` — entity name
- \`metadata.namespace\` — usually "default"
- \`metadata.tags\` — array of tags
- \`spec.type\` — e.g. service, library, website, grpc, openapi
- \`spec.lifecycle\` — production, experimental, deprecated
- \`spec.owner\` — owner ref, e.g. group:default/my-team
- \`spec.system\` — system ref
- \`spec.domain\` — domain ref
- \`relations.memberof\` — for group membership`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG_TOOLS: Anthropic.Tool[] = [
  {
    name: 'query_catalog',
    description: `Search and filter the Backstage catalog. This is the primary tool for finding entities.
Supports:
- Full-text search (searches names, titles, descriptions, tags, and annotations server-side)
- Field filters (kind, type, lifecycle, owner, system, domain, tags, annotations)
- Combining text search + filters simultaneously
- Pagination for large result sets
Use this for: "find X", "list all Y", "show components in system Z", "which services are deprecated?"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        fullTextSearch: {
          type: 'string',
          description:
            'Free-text search term. Searches across entity names, titles, descriptions, tags, and annotations. Leave empty to list/filter without text search.',
        },
        filters: {
          type: 'object',
          description:
            'Field filters. Each key is a catalog field path, value is the required value (or array of values). Examples: {"kind": "Component"}, {"spec.lifecycle": "production"}, {"metadata.tags": "java"}, {"spec.owner": "group:default/my-team"}, {"spec.system": "system:default/payments"}',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        limit: {
          type: 'number',
          description: 'Max entities to return (default 25, max 200)',
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default 0)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_entity_details',
    description: `Get the FULL details of a specific entity by its entity reference.
Returns: all metadata (name, title, description, tags, labels, annotations), spec fields (type, lifecycle, owner, system, domain, dependsOn, providesApis, consumesApis, members, profile), ALL relations, and links.
Use when you have an exact entityRef and need complete information about that entity.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        entityRef: {
          type: 'string',
          description:
            'Entity reference in format kind:namespace/name, e.g. component:default/my-service',
        },
      },
      required: ['entityRef'],
    },
  },
  {
    name: 'get_entity_relations',
    description: `Traverse the relationships of an entity — get all entities related to it by a specific relationship type.
Relation types include:
- "dependsOn" / "dependencyOf" — dependency graph
- "providesApi" / "consumesApi" — API relationships
- "ownedBy" / "ownerOf" — ownership
- "partOf" / "hasPart" — system/domain membership
- "memberOf" / "hasMember" — group membership
- Leave relationType empty to get ALL relations of the entity.
Use for: "what depends on X?", "what APIs does Y provide?", "who are the members of team Z?", "what is part of system S?"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        entityRef: {
          type: 'string',
          description:
            'The source entity ref, e.g. component:default/my-service',
        },
        relationType: {
          type: 'string',
          description:
            'Filter to a specific relation type. One of: dependsOn, dependencyOf, providesApi, consumesApi, ownedBy, ownerOf, partOf, hasPart, memberOf, hasMember. Leave empty for all relations.',
        },
        resolveTargets: {
          type: 'boolean',
          description:
            'If true, fetch full details of each related entity (not just the ref). Default false for performance.',
        },
      },
      required: ['entityRef'],
    },
  },
  {
    name: 'get_catalog_facets',
    description: `Get aggregated counts/statistics across the catalog. Answers questions like:
- "How many components does each team own?"
- "What lifecycle stages exist and how many entities in each?"
- "What types of components are in the catalog?"
- "Which tags are most common?"
- "How many entities per system?"
Returns facet buckets with counts.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        facets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of field paths to aggregate by. Examples: ["kind"], ["spec.owner"], ["spec.lifecycle"], ["spec.type"], ["metadata.tags"], ["spec.system"]. Can request multiple facets at once.',
        },
        filters: {
          type: 'object',
          description:
            'Optional filters to scope the facets, same format as query_catalog filters.',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
      required: ['facets'],
    },
  },
  {
    name: 'get_api_definition',
    description: `Get the full API specification/definition for an API entity.
Returns the complete OpenAPI, AsyncAPI, GraphQL, or gRPC definition text.
Use when a user wants to see what endpoints/operations an API exposes.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        entityRef: {
          type: 'string',
          description: 'API entity reference, e.g. api:default/my-api',
        },
      },
      required: ['entityRef'],
    },
  },
  {
    name: 'get_backstage_info',
    description:
      'Get information about this Backstage instance: installed plugins, app title, and base URLs.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Entity formatting
// ─────────────────────────────────────────────────────────────────────────────

// Annotations that are useful to surface (skip internal/noise ones)
const USEFUL_ANNOTATION_PREFIXES = [
  'github.com/',
  'gitlab.com/',
  'azure.com/',
  'bitbucket.org/',
  'pagerduty.com/',
  'backstage.io/techdocs',
  'backstage.io/kubernetes',
  'backstage.io/source-location',
  'backstage.io/managed-by',
  'jenkins.io/',
  'sonarqube.org/',
  'circleci.com/',
  'jira.com/',
  'confluence.com/',
  'datadog.com/',
  'newrelic.com/',
  'sentry.io/',
  'grafana.com/',
  'prometheus.io/',
  'argocd.argoproj.io/',
  'app.kubernetes.io/',
  'kubernetes.io/',
];

function shouldIncludeAnnotation(key: string): boolean {
  return USEFUL_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix));
}

function formatEntity(entity: any, verbose = false): string {
  const meta = entity.metadata || {};
  const spec = entity.spec || {};
  const lines: string[] = [
    `**${entity.kind}: ${meta.namespace}/${meta.name}**`,
  ];

  if (meta.title && meta.title !== meta.name)
    lines.push(`Title: ${meta.title}`);
  if (meta.description) lines.push(`Description: ${meta.description}`);
  if (spec.type) lines.push(`Type: ${spec.type}`);
  if (spec.lifecycle) lines.push(`Lifecycle: ${spec.lifecycle}`);
  if (spec.owner) lines.push(`Owner: ${spec.owner}`);
  if (spec.system) lines.push(`System: ${spec.system}`);
  if (spec.domain) lines.push(`Domain: ${spec.domain}`);
  if (spec.subcomponentOf)
    lines.push(`Subcomponent of: ${spec.subcomponentOf}`);
  if (spec.profile?.displayName)
    lines.push(`Display name: ${spec.profile.displayName}`);
  if (spec.profile?.email) lines.push(`Email: ${spec.profile.email}`);
  if (meta.tags?.length) lines.push(`Tags: ${meta.tags.join(', ')}`);

  // Labels
  if (meta.labels && Object.keys(meta.labels).length) {
    const labelStr = Object.entries(meta.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    lines.push(`Labels: ${labelStr}`);
  }

  // Useful annotations
  if (meta.annotations) {
    const usefulAnnotations = Object.entries(meta.annotations).filter(([k]) =>
      shouldIncludeAnnotation(k),
    );
    if (usefulAnnotations.length) {
      lines.push(`Annotations:`);
      for (const [k, v] of usefulAnnotations) {
        lines.push(`  ${k}: ${v}`);
      }
    }
  }

  // Spec fields
  if (spec.dependsOn?.length)
    lines.push(`Depends on: ${spec.dependsOn.join(', ')}`);
  if (spec.providesApis?.length)
    lines.push(`Provides APIs: ${spec.providesApis.join(', ')}`);
  if (spec.consumesApis?.length)
    lines.push(`Consumes APIs: ${spec.consumesApis.join(', ')}`);
  if (spec.subcomponentsOf?.length)
    lines.push(`Subcomponents of: ${spec.subcomponentsOf.join(', ')}`);
  if (spec.memberOf?.length)
    lines.push(`Member of: ${spec.memberOf.join(', ')}`);
  if (spec.members?.length) lines.push(`Members: ${spec.members.join(', ')}`);

  // Relations — show all if verbose, or first 20 otherwise
  if (entity.relations?.length) {
    const rels = verbose ? entity.relations : entity.relations.slice(0, 20);
    const relStr = rels
      .map((r: any) => `${r.type} → ${r.targetRef}`)
      .join('\n  ');
    lines.push(`Relations (${entity.relations.length} total):\n  ${relStr}`);
  }

  // Links
  if (meta.links?.length) {
    const linkStr = meta.links
      .map((l: any) => `${l.title || l.url}: ${l.url}`)
      .join(', ');
    lines.push(`Links: ${linkStr}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { config, discovery, auth, logger } = options;

  const apiKey = config.getOptionalString('aiAssistant.anthropicApiKey');
  if (!apiKey) {
    logger.warn(
      'AI Assistant: No Anthropic API key configured (aiAssistant.anthropicApiKey). Chat will return errors.',
    );
  }

  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
  const catalogClient = new CatalogClient({ discoveryApi: discovery });

  async function getCatalogToken(): Promise<string | undefined> {
    try {
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      return token;
    } catch {
      return undefined;
    }
  }

  // Convert the flat filters object from Claude into a Backstage EntityFilterQuery
  function buildFilter(
    filters?: Record<string, string | string[]>,
  ): Record<string, string | string[]> | undefined {
    if (!filters || !Object.keys(filters).length) return undefined;
    return filters;
  }

  async function executeTool(
    toolName: string,
    toolInput: any,
  ): Promise<string> {
    const token = await getCatalogToken();

    // ── query_catalog ─────────────────────────────────────────────────────────
    if (toolName === 'query_catalog') {
      const {
        fullTextSearch,
        filters,
        limit = 25,
        offset = 0,
      } = toolInput as {
        fullTextSearch?: string;
        filters?: Record<string, string | string[]>;
        limit?: number;
        offset?: number;
      };

      const cappedLimit = Math.min(limit, 200);
      const filter = buildFilter(filters);

      // If there's a text search term, use queryEntities (server-side full-text)
      if (fullTextSearch?.trim()) {
        const result = await catalogClient.queryEntities(
          {
            filter,
            fullTextFilter: { term: fullTextSearch.trim() },
            limit: cappedLimit,
            offset,
          },
          { token },
        );
        if (!result.items.length)
          return `No entities found matching "${fullTextSearch}"${
            filter ? ' with the given filters' : ''
          }.`;
        const summary = `Found ${
          result.totalItems ?? result.items.length
        } entities (showing ${result.items.length}):`;
        return `${summary}\n\n${result.items
          .map(e => formatEntity(e))
          .join('\n\n---\n\n')}`;
      }

      // Filter-only query
      const result = await catalogClient.getEntities(
        { filter, limit: cappedLimit },
        { token },
      );
      if (!result.items.length)
        return filter
          ? `No entities found matching the given filters.`
          : `The catalog appears to be empty.`;
      const summary = `Found ${result.items.length} entities:`;
      return `${summary}\n\n${result.items
        .map(e => formatEntity(e))
        .join('\n\n---\n\n')}`;
    }

    // ── get_entity_details ────────────────────────────────────────────────────
    if (toolName === 'get_entity_details') {
      const { entityRef } = toolInput as { entityRef: string };
      const entity = await catalogClient.getEntityByRef(entityRef, { token });
      if (!entity) return `Entity '${entityRef}' not found in the catalog.`;
      return formatEntity(entity, true /* verbose — show all relations */);
    }

    // ── get_entity_relations ──────────────────────────────────────────────────
    if (toolName === 'get_entity_relations') {
      const {
        entityRef,
        relationType,
        resolveTargets = false,
      } = toolInput as {
        entityRef: string;
        relationType?: string;
        resolveTargets?: boolean;
      };

      const entity = await catalogClient.getEntityByRef(entityRef, { token });
      if (!entity)
        return `Entity '${entityRef}' not found. Cannot traverse relations.`;

      let relations: any[] = entity.relations || [];
      if (relationType) {
        relations = relations.filter(
          r => r.type.toLowerCase() === relationType.toLowerCase(),
        );
      }

      if (!relations.length) {
        return relationType
          ? `No '${relationType}' relations found for '${entityRef}'.`
          : `No relations found for '${entityRef}'.`;
      }

      if (!resolveTargets) {
        const grouped: Record<string, string[]> = {};
        for (const r of relations) {
          grouped[r.type] = grouped[r.type] || [];
          grouped[r.type].push(r.targetRef);
        }
        const lines = Object.entries(grouped).map(
          ([type, refs]) =>
            `**${type}** (${refs.length}):\n  ${refs.join('\n  ')}`,
        );
        return `Relations for ${entityRef}:\n\n${lines.join('\n\n')}`;
      }

      // Resolve each target entity
      const targetRefs = [...new Set(relations.map(r => r.targetRef))].slice(
        0,
        50,
      );
      const resolved = await catalogClient.getEntitiesByRefs(
        { entityRefs: targetRefs },
        { token },
      );

      const grouped: Record<string, string[]> = {};
      for (const r of relations) {
        grouped[r.type] = grouped[r.type] || [];
        grouped[r.type].push(r.targetRef);
      }

      const parts: string[] = [`Relations for **${entityRef}**:\n`];
      for (const [type, refs] of Object.entries(grouped)) {
        parts.push(`### ${type} (${refs.length})`);
        for (const ref of refs) {
          const found = resolved.items.find(
            (e: any) =>
              e &&
              `${e.kind.toLowerCase()}:${e.metadata.namespace}/${
                e.metadata.name
              }` === ref.toLowerCase(),
          );
          parts.push(
            found ? formatEntity(found) : `- ${ref} (details not available)`,
          );
          parts.push('---');
        }
      }
      return parts.join('\n');
    }

    // ── get_catalog_facets ────────────────────────────────────────────────────
    if (toolName === 'get_catalog_facets') {
      const { facets, filters } = toolInput as {
        facets: string[];
        filters?: Record<string, string | string[]>;
      };

      const filter = buildFilter(filters);
      const result = await catalogClient.getEntityFacets(
        { facets, filter },
        { token },
      );

      const lines: string[] = ['**Catalog Statistics:**\n'];
      for (const [facetName, facetResult] of Object.entries(result.facets)) {
        lines.push(`### ${facetName}`);
        if (!facetResult.length) {
          lines.push('  (no data)');
          continue;
        }
        const sorted = [...facetResult].sort((a, b) => b.count - a.count);
        for (const { value, count } of sorted) {
          lines.push(`  - **${value || '(none)'}**: ${count}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    // ── get_api_definition ────────────────────────────────────────────────────
    if (toolName === 'get_api_definition') {
      const { entityRef } = toolInput as { entityRef: string };
      const entity = await catalogClient.getEntityByRef(entityRef, { token });
      if (!entity) return `API entity '${entityRef}' not found.`;
      const spec = (entity.spec || {}) as any;
      if (!spec.definition)
        return `No definition found for '${entityRef}'. It may not be an API entity or the definition field is empty.`;
      return `**API: ${entity.metadata.name}**\nType: ${
        spec.type || 'unknown'
      }\nLifecycle: ${spec.lifecycle || 'unknown'}\nOwner: ${
        spec.owner || 'unknown'
      }\n\n**Definition:**\n\`\`\`\n${spec.definition}\n\`\`\``;
    }

    // ── get_backstage_info ────────────────────────────────────────────────────
    if (toolName === 'get_backstage_info') {
      const appBase =
        config.getOptionalString('app.baseUrl') || 'http://localhost:3000';
      const backendBase =
        config.getOptionalString('backend.baseUrl') || 'http://localhost:7007';
      const title = config.getOptionalString('app.title') || 'Backstage';
      return [
        `**Backstage Instance: ${title}**`,
        `App URL: ${appBase}`,
        `Backend URL: ${backendBase}`,
        ``,
        `**Installed Plugins / Features:**`,
        `- Software Catalog (catalog)`,
        `- API Documentation (api-docs)`,
        `- Scaffolder / Templates (scaffolder)`,
        `- Technical Documentation / TechDocs (techdocs)`,
        `- Search (search)`,
        `- Kubernetes (kubernetes)`,
        `- Notifications (notifications)`,
        `- Home Page (home)`,
        `- Organization / People (org)`,
        `- DevTools (devtools)`,
        `- Catalog Graph (catalog-graph)`,
        `- Catalog Import (catalog-import)`,
        `- Permission Framework (permission)`,
        `- Signals (real-time updates)`,
        `- AI Assistant (ai-assistant) — this plugin`,
      ].join('\n');
    }

    return `Unknown tool: ${toolName}`;
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => {
    res.json({ status: 'ok', plugin: 'ai-assistant' });
  });

  router.get('/context', async (_req, res) => {
    try {
      const token = await getCatalogToken();
      const facets = await catalogClient.getEntityFacets(
        { facets: ['kind', 'spec.lifecycle', 'spec.type'] },
        { token },
      );
      res.json({ facets: facets.facets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/chat', async (req, res) => {
    const { messages } = req.body as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!messages || !messages.length) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    if (!anthropic) {
      res.status(503).json({
        error:
          'AI Assistant is not configured. Please set aiAssistant.anthropicApiKey in app-config.yaml.',
      });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const conversationMessages: Anthropic.MessageParam[] = messages.map(
        m => ({
          role: m.role,
          content: m.content,
        }),
      );

      let iterationCount = 0;
      const maxIterations = 15; // allow deeper agentic loops for complex questions

      while (iterationCount < maxIterations) {
        iterationCount++;

        const response = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 8192,
          thinking: { type: 'enabled', budget_tokens: 4000 },
          system: SYSTEM_PROMPT,
          tools: CATALOG_TOOLS,
          messages: conversationMessages,
        });

        // Send text blocks to the frontend
        let hasText = false;
        for (const block of response.content) {
          if (block.type === 'text' && block.text) {
            hasText = true;
            sendEvent('text', { text: block.text });
          }
        }

        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            b => b.type === 'tool_use',
          ) as Anthropic.ToolUseBlock[];

          for (const tool of toolUseBlocks) {
            sendEvent('tool_call', { name: tool.name, input: tool.input });
          }

          conversationMessages.push({
            role: 'assistant',
            content: response.content,
          });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tool of toolUseBlocks) {
            let result: string;
            try {
              result = await executeTool(tool.name, tool.input);
            } catch (err: any) {
              logger.error(`Tool ${tool.name} failed: ${err.message}`);
              result = `Error executing ${tool.name}: ${err.message}`;
            }
            sendEvent('tool_result', {
              name: tool.name,
              preview: result.slice(0, 120),
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result,
            });
          }

          conversationMessages.push({ role: 'user', content: toolResults });
          continue;
        }

        if (!hasText) {
          sendEvent('text', { text: 'I was unable to generate a response.' });
        }
        break;
      }

      sendEvent('done', { finished: true });
      res.end();
    } catch (err: any) {
      logger.error(`AI Assistant chat error: ${err.message}`);
      sendEvent('error', {
        message: err.message || 'An unexpected error occurred',
      });
      res.end();
    }
  });

  return router;
}
