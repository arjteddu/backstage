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

const SYSTEM_PROMPT = `You are an intelligent AI assistant built into a Backstage developer portal. You have full knowledge of this Backstage instance and can answer questions about:

- The **Software Catalog**: components, APIs, systems, domains, resources, groups, users, and their relationships
- **Plugins and features** available in this Backstage instance
- **Technical documentation** (TechDocs) for components
- **Scaffolder templates** for creating new software
- **Search** across the portal
- **Kubernetes** clusters and workloads linked to catalog entities
- **CI/CD pipelines**, GitHub/GitLab integrations
- **API definitions** (OpenAPI, AsyncAPI, GraphQL, gRPC)
- **Ownership, dependencies, and relationships** between entities

You have access to tools to query the live catalog data. When users ask about specific components, systems, teams, or APIs, use the tools to fetch real-time data rather than guessing.

Be concise, helpful, and specific. When you return entity details, format them clearly with relevant metadata like owner, lifecycle, description, tags, and links.`;

const CATALOG_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_catalog_entities',
    description:
      'List entities from the Backstage software catalog. Use this to get an overview of what components, APIs, systems, groups, or users exist. Supports filtering by kind.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          description:
            'Entity kind to filter by (e.g. Component, API, System, Domain, Group, User, Resource, Template). Leave empty for all kinds.',
          enum: [
            'Component',
            'API',
            'System',
            'Domain',
            'Group',
            'User',
            'Resource',
            'Template',
            'Location',
          ],
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of entities to return (default 20, max 100)',
        },
        namespace: {
          type: 'string',
          description: 'Namespace to filter by (default: default)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_entity_details',
    description:
      'Get full details of a specific catalog entity by its entityRef (e.g. component:default/my-service). Use this when you need detailed metadata, annotations, relations, or links for a specific entity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entityRef: {
          type: 'string',
          description:
            'Entity reference in the format kind:namespace/name, e.g. component:default/my-service or api:default/my-api',
        },
      },
      required: ['entityRef'],
    },
  },
  {
    name: 'search_catalog',
    description:
      'Search the Backstage catalog for entities matching a text query. Use this when a user asks about a specific service, team, API, or component by name or description.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search text to find matching entities',
        },
        kind: {
          type: 'string',
          description: 'Optional kind filter (Component, API, System, etc.)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entities_by_owner',
    description:
      'Get all catalog entities owned by a specific team or user. Use this to answer questions like "what does team X own?" or "what services are owned by group Y?"',
    input_schema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description:
            'Owner reference, e.g. group:default/team-alpha or user:default/john.doe',
        },
        kind: {
          type: 'string',
          description: 'Optional kind filter to narrow results',
        },
      },
      required: ['owner'],
    },
  },
  {
    name: 'get_api_definition',
    description:
      'Get the API specification/definition for an API entity. Returns the OpenAPI, AsyncAPI, GraphQL, or gRPC definition.',
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
      'Get information about this Backstage instance: installed plugins, base URLs, and general configuration.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

function formatEntity(entity: any): string {
  const meta = entity.metadata || {};
  const spec = entity.spec || {};
  const lines: string[] = [
    `**${entity.kind}: ${meta.namespace}/${meta.name}**`,
  ];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.description) lines.push(`Description: ${meta.description}`);
  if (spec.type) lines.push(`Type: ${spec.type}`);
  if (spec.lifecycle) lines.push(`Lifecycle: ${spec.lifecycle}`);
  if (spec.owner) lines.push(`Owner: ${spec.owner}`);
  if (spec.system) lines.push(`System: ${spec.system}`);
  if (spec.domain) lines.push(`Domain: ${spec.domain}`);
  if (meta.tags?.length) lines.push(`Tags: ${meta.tags.join(', ')}`);
  if (meta.links?.length) {
    lines.push(
      `Links: ${meta.links
        .map((l: any) => `${l.title || l.url}: ${l.url}`)
        .join(', ')}`,
    );
  }
  if (spec.dependsOn?.length)
    lines.push(`Depends on: ${spec.dependsOn.join(', ')}`);
  if (spec.providesApis?.length)
    lines.push(`Provides APIs: ${spec.providesApis.join(', ')}`);
  if (spec.consumesApis?.length)
    lines.push(`Consumes APIs: ${spec.consumesApis.join(', ')}`);
  if (entity.relations?.length) {
    const rels = entity.relations
      .slice(0, 10)
      .map((r: any) => `${r.type} → ${r.targetRef}`)
      .join(', ');
    lines.push(`Relations: ${rels}`);
  }
  return lines.join('\n');
}

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

  async function executeTool(
    toolName: string,
    toolInput: any,
  ): Promise<string> {
    const token = await getCatalogToken();

    if (toolName === 'list_catalog_entities') {
      const { kind, limit = 20, namespace } = toolInput;
      const filter: Record<string, string> = {};
      if (kind) filter.kind = kind;
      if (namespace) filter['metadata.namespace'] = namespace;

      const result = await catalogClient.getEntities(
        {
          filter: Object.keys(filter).length ? filter : undefined,
          limit: Math.min(limit, 100),
        },
        { token },
      );
      if (!result.items.length) return 'No entities found.';
      return result.items.map(formatEntity).join('\n\n---\n\n');
    }

    if (toolName === 'get_entity_details') {
      const { entityRef } = toolInput;
      const entity = await catalogClient.getEntityByRef(entityRef, { token });
      if (!entity) return `Entity '${entityRef}' not found in the catalog.`;
      return formatEntity(entity);
    }

    if (toolName === 'search_catalog') {
      const { query, kind } = toolInput;
      const filter: Record<string, string> = {};
      if (kind) filter.kind = kind;

      const allEntities = await catalogClient.getEntities(
        {
          filter: Object.keys(filter).length ? filter : undefined,
          limit: 200,
        },
        { token },
      );

      const lq = query.toLowerCase();
      const matches = allEntities.items.filter(e => {
        const name = e.metadata.name.toLowerCase();
        const title = (e.metadata.title || '').toLowerCase();
        const desc = (e.metadata.description || '').toLowerCase();
        const tags = (e.metadata.tags || []).join(' ').toLowerCase();
        return (
          name.includes(lq) ||
          title.includes(lq) ||
          desc.includes(lq) ||
          tags.includes(lq)
        );
      });

      if (!matches.length) return `No entities found matching '${query}'.`;
      return matches.slice(0, 20).map(formatEntity).join('\n\n---\n\n');
    }

    if (toolName === 'get_entities_by_owner') {
      const { owner, kind } = toolInput;
      const filter: Record<string, string | string[]> = {
        'spec.owner': owner,
      };
      if (kind) filter.kind = kind;

      const result = await catalogClient.getEntities(
        { filter, limit: 50 },
        { token },
      );
      if (!result.items.length) return `No entities found owned by '${owner}'.`;
      return result.items.map(formatEntity).join('\n\n---\n\n');
    }

    if (toolName === 'get_api_definition') {
      const { entityRef } = toolInput;
      const entity = await catalogClient.getEntityByRef(entityRef, { token });
      if (!entity) return `API entity '${entityRef}' not found.`;
      const spec = (entity.spec || {}) as any;
      if (!spec.definition) return `No definition found for '${entityRef}'.`;
      return `API Type: ${spec.type || 'unknown'}\n\nDefinition:\n${
        spec.definition
      }`;
    }

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
      const result = await catalogClient.getEntities({ limit: 5 }, { token });
      res.json({
        entityCount: result.items.length,
        kinds: [...new Set(result.items.map(e => e.kind))],
      });
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

    // Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Agentic loop — Claude may call tools multiple times
      const conversationMessages: Anthropic.MessageParam[] = messages.map(
        m => ({ role: m.role, content: m.content }),
      );

      let iterationCount = 0;
      const maxIterations = 10;

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

        // Stream text blocks as they appear in the response
        let hasText = false;
        for (const block of response.content) {
          if (block.type === 'text' && block.text) {
            hasText = true;
            sendEvent('text', { text: block.text });
          }
        }

        // If Claude wants to use tools, execute them and loop
        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            b => b.type === 'tool_use',
          ) as Anthropic.ToolUseBlock[];

          // Let frontend know tools are being called
          for (const tool of toolUseBlocks) {
            sendEvent('tool_call', { name: tool.name, input: tool.input });
          }

          // Add assistant's response (with tool_use blocks) to history
          conversationMessages.push({
            role: 'assistant',
            content: response.content,
          });

          // Execute all tool calls and collect results
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
              preview: result.slice(0, 100),
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result,
            });
          }

          // Feed tool results back into the conversation
          conversationMessages.push({
            role: 'user',
            content: toolResults,
          });

          // Continue the loop so Claude can respond with tool results
          continue;
        }

        // Claude finished — no more tool calls
        if (!hasText) {
          // Shouldn't happen, but just in case
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
