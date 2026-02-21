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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  configApiRef,
  discoveryApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Content, Header, Page } from '@backstage/core-components';
import Box from '@material-ui/core/Box';
import CircularProgress from '@material-ui/core/CircularProgress';
import IconButton from '@material-ui/core/IconButton';
import InputAdornment from '@material-ui/core/InputAdornment';
import Paper from '@material-ui/core/Paper';
import TextField from '@material-ui/core/TextField';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import SendIcon from '@material-ui/icons/Send';
import DeleteSweepIcon from '@material-ui/icons/DeleteSweep';
import SmartToyIcon from '@material-ui/icons/Memory';
import PersonIcon from '@material-ui/icons/Person';
import BuildIcon from '@material-ui/icons/Build';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: string[];
  isStreaming?: boolean;
}

const SUGGESTED_PROMPTS = [
  'What components are in the catalog?',
  'Show me all APIs and their owners',
  'Which team owns the most services?',
  'List all systems and their domains',
  'What templates are available for scaffolding?',
  'Tell me about the plugins installed in this Backstage',
];

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 120px)',
    maxWidth: 900,
    margin: '0 auto',
    padding: theme.spacing(2),
    gap: theme.spacing(2),
  },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
    padding: theme.spacing(1),
    '&::-webkit-scrollbar': { width: 6 },
    '&::-webkit-scrollbar-thumb': {
      background: theme.palette.divider,
      borderRadius: 3,
    },
  },
  messageBubble: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1.5),
  },
  userBubble: {
    flexDirection: 'row-reverse',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 4,
  },
  aiAvatar: {
    background: theme.palette.primary.main,
    color: '#fff',
  },
  userAvatar: {
    background: theme.palette.secondary.main,
    color: '#fff',
  },
  bubble: {
    maxWidth: '80%',
    padding: theme.spacing(1.5, 2),
    borderRadius: theme.spacing(2),
    lineHeight: 1.6,
    fontSize: '0.9rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  aiBubble: {
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderTopLeftRadius: 4,
  },
  userBubbleContent: {
    background: theme.palette.primary.main,
    color: '#fff',
    borderTopRightRadius: 4,
  },
  toolCallChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: theme.palette.action.hover,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 12,
    padding: '2px 8px',
    fontSize: '0.7rem',
    color: theme.palette.text.secondary,
    marginBottom: 4,
    marginRight: 4,
  },
  inputArea: {
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'flex-end',
  },
  inputField: {
    flex: 1,
  },
  sendButton: {
    height: 56,
    width: 56,
    flexShrink: 0,
  },
  suggestionsArea: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    justifyContent: 'center',
    padding: theme.spacing(2),
  },
  suggestionChip: {
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 20,
    padding: theme.spacing(0.75, 2),
    cursor: 'pointer',
    fontSize: '0.8rem',
    color: theme.palette.text.secondary,
    transition: 'all 0.15s ease',
    '&:hover': {
      background: theme.palette.primary.main,
      color: '#fff',
      borderColor: theme.palette.primary.main,
    },
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.palette.text.secondary,
    textAlign: 'center',
    gap: theme.spacing(2),
  },
  emptyIcon: {
    fontSize: 64,
    color: theme.palette.primary.light,
    opacity: 0.5,
  },
  streamingDot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: theme.palette.primary.main,
    marginLeft: 2,
    animation: '$blink 1s step-end infinite',
  },
  '@keyframes blink': {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0 },
  },
  headerActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.spacing(1),
  },
}));

export function AiAssistantPage() {
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const configApi = useApi(configApiRef);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const appTitle = configApi.getOptionalString('app.title') || 'Backstage';

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMessage: Message = { role: 'user', content: trimmed };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      setInput('');
      setLoading(true);

      // Add a placeholder for the streaming assistant response
      const assistantPlaceholder: Message = {
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages(prev => [...prev, assistantPlaceholder]);

      try {
        const baseUrl = await discoveryApi.getBaseUrl('ai-assistant');

        const response = await fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: updatedMessages.map(m => ({
              role: m.role,
              content: m.content,
            })),
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: 'assistant',
              content: `Error: ${err.error || 'Something went wrong'}`,
              isStreaming: false,
            };
            return copy;
          });
          return;
        }

        // Parse SSE stream with proper event/data tracking
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEventType = 'message';

        const updateLastMessage = (updater: (prev: Message) => Message) => {
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = updater(copy[copy.length - 1]);
            return copy;
          });
        };

        const handleSseEvent = (eventType: string, dataStr: string) => {
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'text' && data.text) {
              updateLastMessage(prev => ({
                ...prev,
                content: prev.content + data.text,
                isStreaming: true,
              }));
            } else if (eventType === 'tool_call' && data.name) {
              updateLastMessage(prev => ({
                ...prev,
                toolCalls: [...(prev.toolCalls || []), data.name],
              }));
            } else if (eventType === 'done') {
              updateLastMessage(prev => ({ ...prev, isStreaming: false }));
            } else if (eventType === 'error') {
              updateLastMessage(prev => ({
                ...prev,
                content: prev.content || `Error: ${data.message}`,
                isStreaming: false,
              }));
            }
          } catch {
            // ignore malformed JSON
          }
        };

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE events are separated by double newlines
          const parts = buffer.split('\n\n');
          // Keep the last (possibly incomplete) part in the buffer
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            currentEventType = 'message';
            let dataStr = '';
            for (const line of part.split('\n')) {
              if (line.startsWith('event: ')) {
                currentEventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataStr = line.slice(6);
              }
            }
            if (dataStr) {
              handleSseEvent(currentEventType, dataStr);
            }
          }
        }

        // Ensure streaming is marked done
        updateLastMessage(prev => ({ ...prev, isStreaming: false }));
      } catch (err: any) {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: `Error: ${
              err.message || 'Failed to connect to AI assistant'
            }`,
            isStreaming: false,
          };
          return copy;
        });
      } finally {
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [messages, loading, discoveryApi],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input);
      }
    },
    [input, sendMessage],
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  return (
    <Page themeId="tool">
      <Header
        title="AI Assistant"
        subtitle={`Ask anything about your ${appTitle} instance`}
      />
      <Content>
        <Box className={classes.root}>
          {/* Clear button */}
          {messages.length > 0 && (
            <Box className={classes.headerActions}>
              <Tooltip title="Clear conversation">
                <IconButton size="small" onClick={clearChat}>
                  <DeleteSweepIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}

          {/* Messages or empty state */}
          {messages.length === 0 ? (
            <Box className={classes.emptyState}>
              <SmartToyIcon className={classes.emptyIcon} />
              <Typography variant="h5" gutterBottom>
                Backstage AI Assistant
              </Typography>
              <Typography variant="body2" style={{ maxWidth: 480 }}>
                I have full context of your {appTitle} instance — catalog
                entities, APIs, systems, teams, plugins, and more. Ask me
                anything!
              </Typography>
              <Box className={classes.suggestionsArea}>
                {SUGGESTED_PROMPTS.map(prompt => (
                  <Box
                    key={prompt}
                    component="span"
                    className={classes.suggestionChip}
                    onClick={() => sendMessage(prompt)}
                  >
                    {prompt}
                  </Box>
                ))}
              </Box>
            </Box>
          ) : (
            <Box className={classes.messagesContainer}>
              {messages.map((msg, idx) => (
                <Box
                  key={idx}
                  className={`${classes.messageBubble} ${
                    msg.role === 'user' ? classes.userBubble : ''
                  }`}
                >
                  {/* Avatar */}
                  <Box
                    className={`${classes.avatar} ${
                      msg.role === 'assistant'
                        ? classes.aiAvatar
                        : classes.userAvatar
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <SmartToyIcon style={{ fontSize: 18 }} />
                    ) : (
                      <PersonIcon style={{ fontSize: 18 }} />
                    )}
                  </Box>

                  {/* Bubble content */}
                  <Box style={{ maxWidth: '80%' }}>
                    {/* Tool call chips */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <Box mb={0.5}>
                        {[...new Set(msg.toolCalls)].map(tc => (
                          <Box
                            key={tc}
                            component="span"
                            className={classes.toolCallChip}
                          >
                            <BuildIcon style={{ fontSize: 10 }} />
                            {tc.replace(/_/g, ' ')}
                          </Box>
                        ))}
                      </Box>
                    )}

                    <Paper
                      elevation={0}
                      className={`${classes.bubble} ${
                        msg.role === 'assistant'
                          ? classes.aiBubble
                          : classes.userBubbleContent
                      }`}
                    >
                      {msg.content || (msg.isStreaming ? '' : '…')}
                      {msg.isStreaming && (
                        <Box
                          component="span"
                          className={classes.streamingDot}
                        />
                      )}
                    </Paper>
                  </Box>
                </Box>
              ))}
              <div ref={messagesEndRef} />
            </Box>
          )}

          {/* Input area */}
          <Box className={classes.inputArea}>
            <TextField
              inputRef={inputRef}
              className={classes.inputField}
              variant="outlined"
              placeholder="Ask about components, APIs, teams, systems…"
              multiline
              maxRows={4}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              InputProps={{
                endAdornment: loading ? (
                  <InputAdornment position="end">
                    <CircularProgress size={20} />
                  </InputAdornment>
                ) : undefined,
              }}
            />
            <Tooltip title="Send (Enter)">
              <Box component="span">
                <IconButton
                  color="primary"
                  className={classes.sendButton}
                  onClick={() => sendMessage(input)}
                  disabled={loading || !input.trim()}
                >
                  <SendIcon />
                </IconButton>
              </Box>
            </Tooltip>
          </Box>
        </Box>
      </Content>
    </Page>
  );
}
