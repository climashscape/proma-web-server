(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;

  // web/preload.ts
  var exports_preload = {};

  // web/preload-bridge.ts
  function resolveToken() {
    const cfg = globalThis.__PROMA_WEB_CONFIG__;
    if (cfg?.token)
      return cfg.token;
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("token");
    if (fromUrl) {
      try {
        globalThis.localStorage?.setItem("proma_web_token", fromUrl);
      } catch {}
      return fromUrl;
    }
    try {
      return globalThis.localStorage?.getItem("proma_web_token") ?? "";
    } catch {
      return "";
    }
  }
  function resolveWsUrl() {
    const cfg = globalThis.__PROMA_WEB_CONFIG__;
    let base = cfg?.wsUrl;
    if (!base && globalThis.location?.host) {
      const proto = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
      base = `${proto}//${globalThis.location.host}/ws`;
    }
    if (!base)
      base = "ws://127.0.0.1:6810/ws";
    return base + (base.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(resolveToken());
  }

  class WSBridge {
    url;
    ws = null;
    nextId = 1;
    pending = new Map;
    listeners = new Map;
    onceListeners = new Map;
    syncCache = new Map;
    reconnectDelay = 1000;
    closedByUser = false;
    readyResolve = null;
    readyReject = null;
    readyPromise = Promise.resolve();
    statusListeners = new Set;
    currentStatus = "closed";
    token;
    get ready() {
      return this.readyPromise;
    }
    constructor(url) {
      this.url = url;
      this.token = resolveToken();
      if (!this.token) {
        this.setStatus("no-token", { reason: "missing token" });
        return;
      }
      this.connect();
    }
    onStatusChange(fn) {
      this.statusListeners.add(fn);
      try {
        fn(this.currentStatus);
      } catch (e) {
        console.error("[bridge] status listener error:", e);
      }
      return this;
    }
    offStatusChange(fn) {
      this.statusListeners.delete(fn);
      return this;
    }
    setStatus(status, info) {
      this.currentStatus = status;
      for (const fn of [...this.statusListeners]) {
        try {
          fn(status, info);
        } catch (e) {
          console.error("[bridge] status listener error:", e);
        }
      }
    }
    resetReady() {
      this.readyPromise = new Promise((res, rej) => {
        this.readyResolve = res;
        this.readyReject = rej;
      });
    }
    reconnectScheduled = false;
    connect() {
      if (this.closedByUser)
        return;
      if (!this.token) {
        this.setStatus("no-token", { reason: "missing token" });
        return;
      }
      const st = this.ws?.readyState;
      if (st === WebSocket.OPEN || st === WebSocket.CONNECTING)
        return;
      this.resetReady();
      this.setStatus(st === WebSocket.CLOSED || st === WebSocket.CLOSING ? "reconnecting" : "connecting");
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.reconnectDelay = 1000;
        this.setStatus("connected");
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg?.type) {
          case "ready":
            if (this.readyResolve) {
              this.readyResolve();
              this.readyResolve = null;
            }
            break;
          case "result":
            this.settle(msg.id, msg);
            break;
          case "event":
            this.dispatch(msg.channel, msg.payload);
            break;
          case "ping":
            this.sendRaw({ type: "pong", t: msg.t });
            break;
          case "bye":
          case "error":
            break;
        }
      };
      ws.onclose = (ev) => {
        if (this.closedByUser)
          return;
        if (ev.code === 1001 || ev.code === 4003) {
          this.closedByUser = true;
          this.rejectAllPending(new Error(`ws closed by server (code ${ev.code})`));
          this.rejectReady(new Error(`ws closed by server (code ${ev.code})`));
          this.setStatus("closed", { code: ev.code, reason: "closed by server" });
          return;
        }
        if (ev.code === 4002) {
          this.rejectAllPending(new Error("ws superseded by another connection, reconnecting…"));
          this.rejectReady(new Error("ws superseded by another connection, reconnecting…"));
          this.setStatus("reconnecting", { code: 4002, reason: "superseded" });
          this.scheduleReconnect(5000);
          return;
        }
        this.rejectAllPending(new Error("ws disconnected, reconnecting…"));
        this.rejectReady(new Error("ws disconnected, reconnecting…"));
        this.setStatus("reconnecting", { code: ev.code, reason: "disconnected" });
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    }
    rejectAllPending(err) {
      for (const [, p] of this.pending)
        p.reject(err);
      this.pending.clear();
    }
    rejectReady(err) {
      if (this.readyReject) {
        this.readyReject(err);
        this.readyReject = null;
      }
    }
    scheduleReconnect(delayOverride) {
      if (this.closedByUser)
        return;
      if (this.reconnectScheduled)
        return;
      this.reconnectScheduled = true;
      const delay = delayOverride ?? this.reconnectDelay;
      setTimeout(() => {
        this.reconnectScheduled = false;
        if (this.closedByUser)
          return;
        this.connect();
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }, delay);
    }
    ensureConnecting() {
      if (this.closedByUser || !this.token)
        return;
      const st = this.ws?.readyState;
      if (this.ws === null || st === WebSocket.CLOSED) {
        if (!this.reconnectScheduled)
          this.connect();
      }
    }
    sendRaw(frame) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(frame));
      }
    }
    dispose() {
      this.closedByUser = true;
      this.rejectAllPending(new Error("bridge disposed"));
      this.rejectReady(new Error("bridge disposed"));
      this.setStatus("closed", { reason: "disposed" });
      try {
        this.ws?.close();
      } catch {}
    }
    trimUndefinedArgs(args) {
      let end = args.length;
      while (end > 0 && args[end - 1] === undefined)
        end--;
      return args.slice(0, end);
    }
    invoke(channel, ...args) {
      const id = this.nextId++;
      const trimmed = this.trimUndefinedArgs(args);
      return new Promise((resolve, reject) => {
        const sendIfOpen = () => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.pending.set(id, { resolve, reject });
            this.sendRaw({ type: "invoke", id, channel, args: trimmed });
            return true;
          }
          return false;
        };
        if (sendIfOpen())
          return;
        if (this.closedByUser) {
          reject(new Error(`[bridge] ws closed, cannot invoke ${channel}`));
          return;
        }
        this.ensureConnecting();
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (sendIfOpen())
            return;
          if (this.closedByUser || Date.now() > deadline) {
            reject(new Error(`[bridge] ws not ready, cannot invoke ${channel}`));
            return;
          }
          this.ensureConnecting();
          setTimeout(poll, 200);
        };
        setTimeout(poll, 200);
      });
    }
    send(channel, ...args) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const id = this.nextId++;
        this.sendRaw({ type: "invoke", id, channel, args: this.trimUndefinedArgs(args) });
      }
    }
    sendSync(channel, ...args) {
      this.invoke(channel, ...args).then((v) => this.syncCache.set(channel, v)).catch(() => {});
      if (!this.syncCache.has(channel)) {
        return true;
      }
      return this.syncCache.get(channel);
    }
    settle(id, msg) {
      const p = this.pending.get(id);
      if (!p)
        return;
      this.pending.delete(id);
      if (msg.ok)
        p.resolve(msg.result);
      else
        p.reject(new Error(msg.error ?? "invoke failed"));
    }
    on(channel, fn) {
      if (!this.listeners.has(channel))
        this.listeners.set(channel, new Set);
      this.listeners.get(channel).add(fn);
      return this;
    }
    once(channel, fn) {
      if (!this.onceListeners.has(channel))
        this.onceListeners.set(channel, new Set);
      this.onceListeners.get(channel).add(fn);
      return this;
    }
    removeListener(channel, fn) {
      this.listeners.get(channel)?.delete(fn);
      this.onceListeners.get(channel)?.delete(fn);
      return this;
    }
    removeAllListeners(channel) {
      if (channel) {
        this.listeners.delete(channel);
        this.onceListeners.delete(channel);
      } else {
        this.listeners.clear();
        this.onceListeners.clear();
      }
      return this;
    }
    dispatch(channel, payload) {
      const ev = { channel, sender: null, returnValue: undefined };
      const args = Array.isArray(payload) ? payload : [payload];
      const onceSet = this.onceListeners.get(channel);
      if (onceSet && onceSet.size > 0) {
        const toCall = [...onceSet];
        onceSet.clear();
        for (const fn of toCall) {
          try {
            fn(ev, ...args);
          } catch (e) {
            console.error("[bridge] once listener error:", e);
          }
        }
      }
      const set = this.listeners.get(channel);
      if (set && set.size > 0) {
        for (const fn of [...set]) {
          try {
            fn(ev, ...args);
          } catch (e) {
            console.error("[bridge] listener error:", e);
          }
        }
      }
    }
  }
  var contextBridge = {
    exposeInMainWorld: (key, api) => {
      globalThis[key] = api;
    }
  };
  var webUtils = {
    getPathForFile: (file) => {
      if (file && typeof file === "object" && "path" in file) {
        const p = file.path;
        if (typeof p === "string" && p)
          return p;
      }
      if (file && typeof file === "object" && "name" in file) {
        const n = file.name;
        if (typeof n === "string")
          return n;
      }
      return "";
    }
  };
  var ipcRenderer = new WSBridge(resolveWsUrl());
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("beforeunload", () => {
      try {
        ipcRenderer.dispose();
      } catch {}
    });
  }

  // ../Proma/packages/shared/src/types/runtime.ts
  var IPC_CHANNELS = {
    GET_RUNTIME_STATUS: "runtime:get-status",
    REINIT_RUNTIME: "runtime:reinit",
    GET_GIT_REPO_STATUS: "git:get-repo-status",
    GET_UNSTAGED_CHANGES: "git:get-unstaged-changes",
    GET_FILE_DIFF: "git:get-file-diff",
    GET_UNTRACKED_CONTENT: "git:get-untracked-content",
    REVERT_FILE: "git:revert-file",
    GET_DIFF_CONTENTS: "git:get-diff-contents",
    LIST_WORKTREES: "git:list-worktrees",
    GET_WORKTREE_CHANGES: "git:get-worktree-changes",
    OPEN_EXTERNAL: "shell:open-external",
    SYSTEM_OPEN_FILE: "shell:system-open-file",
    SHOW_ITEM_IN_FOLDER: "shell:show-item-in-folder",
    SCAN_EDITORS: "shell:scan-editors",
    GET_DEFAULT_APP_FOR_FILE: "shell:get-default-app-for-file",
    OPEN_DETACHED_PREVIEW: "preview:open-detached",
    GET_DETACHED_PREVIEW_DATA: "preview:get-detached-data",
    WINDOW_MINIMIZE: "window:minimize",
    WINDOW_MAXIMIZE: "window:maximize",
    WINDOW_CLOSE: "window:close",
    WINDOW_IS_MAXIMIZED: "window:is-maximized",
    WRITE_CLIPBOARD_TEXT: "clipboard:write-text",
    SCREENSHOT_CAPTURE: "screenshot:capture"
  };
  var SCREENSHOT_LIMITS = {
    MAX_ELEMENTS: 3000,
    MAX_RAW_HTML_BYTES: 2 * 1024 * 1024,
    MAX_HTML_BYTES: 12 * 1024 * 1024,
    MAX_PIXELS: 1e8,
    MIN_WIDTH: 480,
    MAX_WIDTH: 1600
  };
  // ../Proma/packages/shared/src/types/channel.ts
  var CHANNEL_IPC_CHANNELS = {
    LIST: "channel:list",
    CREATE: "channel:create",
    UPDATE: "channel:update",
    DELETE: "channel:delete",
    DECRYPT_KEY: "channel:decrypt-key",
    TEST: "channel:test",
    FETCH_MODELS: "channel:fetch-models",
    TEST_DIRECT: "channel:test-direct",
    GET_PLAN_QUOTA: "channel:get-plan-quota",
    CODEX_OAUTH_LOGIN: "channel:codex-oauth-login",
    CODEX_OAUTH_CANCEL: "channel:codex-oauth-cancel",
    CODEX_OAUTH_DEVICE_CODE: "channel:codex-oauth-device-code",
    XAI_OAUTH_LOGIN: "channel:xai-oauth-login",
    XAI_OAUTH_CANCEL: "channel:xai-oauth-cancel",
    XAI_OAUTH_DEVICE_CODE: "channel:xai-oauth-device-code"
  };
  // ../Proma/packages/shared/src/types/proxy.ts
  var PROXY_IPC_CHANNELS = {
    GET_SETTINGS: "proxy:get-settings",
    UPDATE_SETTINGS: "proxy:update-settings",
    DETECT_SYSTEM: "proxy:detect-system"
  };
  // ../Proma/packages/shared/src/types/chat.ts
  var MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
  var CHAT_IPC_CHANNELS = {
    LIST_CONVERSATIONS: "chat:list-conversations",
    CREATE_CONVERSATION: "chat:create-conversation",
    GET_MESSAGES: "chat:get-messages",
    GET_RECENT_MESSAGES: "chat:get-recent-messages",
    UPDATE_TITLE: "chat:update-title",
    DELETE_CONVERSATION: "chat:delete-conversation",
    UPDATE_MODEL: "chat:update-conversation-model",
    SEND_MESSAGE: "chat:send-message",
    STOP_GENERATION: "chat:stop-generation",
    DELETE_MESSAGE: "chat:delete-message",
    TRUNCATE_MESSAGES_FROM: "chat:truncate-messages-from",
    UPDATE_CONTEXT_DIVIDERS: "chat:update-context-dividers",
    GENERATE_TITLE: "chat:generate-title",
    SAVE_ATTACHMENT: "chat:save-attachment",
    READ_ATTACHMENT: "chat:read-attachment",
    SAVE_IMAGE_AS: "chat:save-image-as",
    SAVE_RESOURCE_FILE_AS: "chat:save-resource-file-as",
    DELETE_ATTACHMENT: "chat:delete-attachment",
    OPEN_FILE_DIALOG: "chat:open-file-dialog",
    EXTRACT_ATTACHMENT_TEXT: "chat:extract-attachment-text",
    TOGGLE_PIN: "chat:toggle-pin",
    TOGGLE_ARCHIVE: "chat:toggle-archive",
    SEARCH_MESSAGES: "chat:search-messages",
    GET_TUTORIAL_CONTENT: "chat:get-tutorial-content",
    CREATE_WELCOME_CONVERSATION: "chat:create-welcome-conversation",
    STREAM_CHUNK: "chat:stream:chunk",
    STREAM_REASONING: "chat:stream:reasoning",
    STREAM_COMPLETE: "chat:stream:complete",
    STREAM_ERROR: "chat:stream:error",
    STREAM_TOOL_ACTIVITY: "chat:stream:tool-activity"
  };
  // ../Proma/packages/shared/src/types/agent.ts
  var AGENT_IPC_CHANNELS = {
    LIST_SESSIONS: "agent:list-sessions",
    CREATE_SESSION: "agent:create-session",
    GET_SDK_MESSAGES: "agent:get-sdk-messages",
    UPDATE_TITLE: "agent:update-title",
    UPDATE_SESSION_MODEL: "agent:update-session-model",
    DELETE_SESSION: "agent:delete-session",
    MIGRATE_CHAT_TO_AGENT: "agent:migrate-chat-to-agent",
    TOGGLE_PIN: "agent:toggle-pin",
    TOGGLE_STAR: "agent:toggle-star",
    CLEAR_COMPLETION_STATE: "agent:confirm-working-done",
    TOGGLE_ARCHIVE: "agent:toggle-archive",
    SEARCH_MESSAGES: "agent:search-messages",
    SEARCH_SESSION_REFERENCES: "agent:search-session-references",
    MOVE_SESSION_TO_WORKSPACE: "agent:move-session-to-workspace",
    FORK_SESSION: "agent:fork-session",
    REWIND_SESSION: "agent:rewind-session",
    LIST_WORKSPACES: "agent:list-workspaces",
    CREATE_WORKSPACE: "agent:create-workspace",
    CREATE_PROJECT: "agent:create-project",
    UPDATE_WORKSPACE: "agent:update-workspace",
    RELINK_WORKSPACE_PROJECT_ROOT: "agent:relink-workspace-project-root",
    RESTORE_WORKSPACE_PROJECT_ROOT: "agent:restore-workspace-project-root",
    DELETE_WORKSPACE: "agent:delete-workspace",
    REORDER_WORKSPACES: "agent:reorder-workspaces",
    GENERATE_TITLE: "agent:generate-title",
    SEND_MESSAGE: "agent:send-message",
    STOP_AGENT: "agent:stop",
    GET_TASK_OUTPUT: "agent:get-task-output",
    STOP_TASK: "agent:stop-task",
    GET_CAPABILITIES: "agent:get-capabilities",
    GET_MCP_CONFIG: "agent:get-mcp-config",
    SAVE_MCP_CONFIG: "agent:save-mcp-config",
    TEST_MCP_SERVER: "agent:test-mcp-server",
    SET_BUILTIN_MCP_ENABLED: "agent:set-builtin-mcp-enabled",
    GET_SKILLS: "agent:get-skills",
    GET_SKILLS_DIR: "agent:get-skills-dir",
    DELETE_SKILL: "agent:delete-skill",
    TOGGLE_SKILL: "agent:toggle-skill",
    GET_OTHER_WORKSPACE_SKILLS: "agent:get-other-workspace-skills",
    GET_DEFAULT_SKILL_SLUGS: "agent:get-default-skill-slugs",
    IMPORT_SKILL_FROM_WORKSPACE: "agent:import-skill-from-workspace",
    BATCH_IMPORT_SKILLS_FROM_WORKSPACES: "agent:batch-import-skills-from-workspaces",
    UPDATE_SKILL_FROM_SOURCE: "agent:update-skill-from-source",
    READ_SKILL_CONTENT: "agent:read-skill-content",
    WRITE_SKILL_CONTENT: "agent:write-skill-content",
    LIST_SKILL_FILES: "agent:list-skill-files",
    READ_SKILL_FILE: "agent:read-skill-file",
    WRITE_SKILL_FILE: "agent:write-skill-file",
    CREATE_SKILL_ENTRY: "agent:create-skill-entry",
    DELETE_SKILL_ENTRY: "agent:delete-skill-entry",
    RENAME_SKILL_ENTRY: "agent:rename-skill-entry",
    GET_WORKSPACE_MEMORY_SUMMARY: "agent:get-workspace-memory-summary",
    READ_WORKSPACE_AGENTS_MD: "agent:read-workspace-agents-md",
    WRITE_WORKSPACE_AGENTS_MD: "agent:write-workspace-agents-md",
    LIST_WORKSPACE_AUTO_MEMORY_FILES: "agent:list-workspace-auto-memory-files",
    READ_WORKSPACE_AUTO_MEMORY_FILE: "agent:read-workspace-auto-memory-file",
    WRITE_WORKSPACE_AUTO_MEMORY_FILE: "agent:write-workspace-auto-memory-file",
    OPEN_WORKSPACE_MEMORY_WINDOW: "agent:open-workspace-memory-window",
    WORKSPACE_MEMORY_WINDOW_OPEN_FILE: "agent:workspace-memory-window-open-file",
    WORKSPACE_MEMORY_WINDOW_CLOSE_REQUESTED: "agent:workspace-memory-window-close-requested",
    CONFIRM_WORKSPACE_MEMORY_WINDOW_CLOSE: "agent:confirm-workspace-memory-window-close",
    WORKSPACE_MEMORY_WINDOW_READY: "agent:workspace-memory-window-ready",
    START_WORKSPACE_MEMORY_WATCH: "agent:start-workspace-memory-watch",
    STOP_WORKSPACE_MEMORY_WATCH: "agent:stop-workspace-memory-watch",
    WORKSPACE_MEMORY_FILE_CHANGED: "agent:workspace-memory-file-changed",
    APPROVE_WORKSPACE_PROJECT_KNOWLEDGE_MAINTENANCE: "agent:approve-workspace-project-knowledge-maintenance",
    STREAM_EVENT: "agent:stream:event",
    STREAM_COMPLETE: "agent:stream:complete",
    STREAM_ERROR: "agent:stream:error",
    SAVE_FILES_TO_SESSION: "agent:save-files-to-session",
    SAVE_FILES_TO_WORKSPACE: "agent:save-files-to-workspace",
    GET_WORKSPACE_FILES_PATH: "agent:get-workspace-files-path",
    OPEN_FOLDER_DIALOG: "agent:open-folder-dialog",
    OPEN_FILE_OR_FOLDER_DIALOG: "agent:open-file-or-folder-dialog",
    ATTACH_DIRECTORY: "agent:attach-directory",
    DETACH_DIRECTORY: "agent:detach-directory",
    ATTACH_FILE: "agent:attach-file",
    DETACH_FILE: "agent:detach-file",
    ATTACH_WORKSPACE_DIRECTORY: "agent:attach-workspace-directory",
    DETACH_WORKSPACE_DIRECTORY: "agent:detach-workspace-directory",
    ATTACH_WORKSPACE_FILE: "agent:attach-workspace-file",
    DETACH_WORKSPACE_FILE: "agent:detach-workspace-file",
    GET_WORKSPACE_DIRECTORIES: "agent:get-workspace-directories",
    GET_WORKSPACE_ATTACHED_FILES: "agent:get-workspace-attached-files",
    GET_WORKTREE_REPOS: "agent:get-worktree-repos",
    ADD_WORKTREE_REPO: "agent:add-worktree-repo",
    REMOVE_WORKTREE_REPO: "agent:remove-worktree-repo",
    GET_SESSION_PATH: "agent:get-session-path",
    LIST_DIRECTORY: "agent:list-directory",
    DELETE_FILE: "agent:delete-file",
    OPEN_FILE: "agent:open-file",
    SHOW_IN_FOLDER: "agent:show-in-folder",
    OPEN_FOLDER_IN_TERMINAL: "agent:open-folder-in-terminal",
    RENAME_FILE: "agent:rename-file",
    MOVE_FILE: "agent:move-file",
    LIST_ATTACHED_DIRECTORY: "agent:list-attached-directory",
    SHOW_ATTACHED_IN_FOLDER: "agent:show-attached-in-folder",
    RENAME_ATTACHED_FILE: "agent:rename-attached-file",
    MOVE_ATTACHED_FILE: "agent:move-attached-file",
    CHECK_PATHS_TYPE: "agent:check-paths-type",
    READ_ATTACHED_FILE: "agent:read-attached-file",
    SEARCH_WORKSPACE_FILES: "agent:search-workspace-files",
    WRITE_CLIPBOARD_PREVIEW: "agent:write-clipboard-preview",
    TITLE_UPDATED: "agent:title-updated",
    CAPABILITIES_CHANGED: "agent:capabilities-changed",
    WORKSPACE_FILES_CHANGED: "agent:workspace-files-changed",
    PERMISSION_RESPOND: "agent:permission:respond",
    UPDATE_SESSION_PERMISSION_MODE: "agent:update-session-permission-mode",
    UPDATE_SESSION_CODEX_FAST_MODE: "agent:update-session-codex-fast-mode",
    GET_PI_REASONING_CAPABILITY: "agent:get-pi-reasoning-capability",
    UPDATE_SESSION_REASONING_LEVEL: "agent:update-session-reasoning-level",
    ASK_USER_RESPOND: "agent:ask-user:respond",
    EXIT_PLAN_MODE_RESPOND: "agent:exit-plan-mode:respond",
    QUEUE_MESSAGE: "agent:queue-message",
    CANCEL_QUEUED_MESSAGE: "agent:cancel-queued-message",
    PROMOTE_QUEUED_MESSAGE: "agent:promote-queued-message",
    QUEUED_MESSAGE_STATUS: "agent:queued-message-status",
    GET_PENDING_REQUESTS: "agent:get-pending-requests"
  };
  // ../Proma/packages/shared/src/types/reasoning-profile.ts
  var OPENAI_STANDARD_LEVELS = ["off", "low", "medium", "high", "xhigh"];
  var OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, "max"];
  var OPENAI_STANDARD_EFFORT_MAP = {
    off: "none",
    minimal: "low",
    xhigh: "xhigh"
  };
  var OPENAI_MAX_EFFORT_MAP = {
    ...OPENAI_STANDARD_EFFORT_MAP,
    max: "max"
  };
  // ../Proma/packages/shared/src/types/environment.ts
  var ENVIRONMENT_IPC_CHANNELS = {
    CHECK: "environment:check"
  };
  // ../Proma/packages/shared/src/types/installer.ts
  var INSTALLER_IPC_CHANNELS = {
    MANIFEST: "installer:manifest",
    DOWNLOAD: "installer:download",
    CANCEL: "installer:cancel",
    LAUNCH: "installer:launch",
    PROGRESS: "installer:progress"
  };
  // ../Proma/packages/shared/src/types/github.ts
  var GITHUB_RELEASE_IPC_CHANNELS = {
    GET_LATEST_RELEASE: "github-release:get-latest",
    LIST_RELEASES: "github-release:list",
    GET_RELEASE_BY_TAG: "github-release:get-by-tag"
  };
  // ../Proma/packages/shared/src/types/system-prompt.ts
  var SYSTEM_PROMPT_IPC_CHANNELS = {
    GET_CONFIG: "system-prompt:get-config",
    CREATE: "system-prompt:create",
    UPDATE: "system-prompt:update",
    DELETE: "system-prompt:delete",
    UPDATE_APPEND_SETTING: "system-prompt:update-append-setting",
    SET_DEFAULT: "system-prompt:set-default"
  };
  // ../Proma/packages/shared/src/types/chat-tool.ts
  var CHAT_TOOL_IPC_CHANNELS = {
    GET_ALL_TOOLS: "chat-tool:get-all-tools",
    GET_TOOL_CREDENTIALS: "chat-tool:get-credentials",
    UPDATE_TOOL_STATE: "chat-tool:update-state",
    UPDATE_TOOL_CREDENTIALS: "chat-tool:update-credentials",
    TEST_TOOL: "chat-tool:test",
    CREATE_CUSTOM_TOOL: "chat-tool:create-custom",
    DELETE_CUSTOM_TOOL: "chat-tool:delete-custom",
    CUSTOM_TOOL_CHANGED: "chat-tool:custom-tool-changed"
  };
  // ../Proma/packages/shared/src/types/feishu.ts
  var FEISHU_IPC_CHANNELS = {
    GET_CONFIG: "feishu:get-config",
    SAVE_CONFIG: "feishu:save-config",
    GET_DECRYPTED_SECRET: "feishu:get-decrypted-secret",
    TEST_CONNECTION: "feishu:test-connection",
    START_BRIDGE: "feishu:start-bridge",
    STOP_BRIDGE: "feishu:stop-bridge",
    GET_STATUS: "feishu:get-status",
    STATUS_CHANGED: "feishu:status-changed",
    LIST_BINDINGS: "feishu:list-bindings",
    UPDATE_BINDING: "feishu:update-binding",
    REMOVE_BINDING: "feishu:remove-binding",
    REPORT_PRESENCE: "feishu:report-presence",
    GET_MULTI_CONFIG: "feishu:get-multi-config",
    SAVE_BOT_CONFIG: "feishu:save-bot-config",
    REMOVE_BOT: "feishu:remove-bot",
    GET_BOT_DECRYPTED_SECRET: "feishu:get-bot-decrypted-secret",
    START_BOT: "feishu:start-bot",
    STOP_BOT: "feishu:stop-bot",
    GET_MULTI_STATUS: "feishu:get-multi-status",
    MULTI_STATUS_CHANGED: "feishu:multi-status-changed",
    REGISTER_APP_START: "feishu:register-app-start",
    REGISTER_APP_QRCODE: "feishu:register-app-qrcode",
    REGISTER_APP_STATUS: "feishu:register-app-status",
    REGISTER_APP_CANCEL: "feishu:register-app-cancel"
  };
  // ../Proma/packages/shared/src/types/dingtalk.ts
  var DINGTALK_IPC_CHANNELS = {
    GET_CONFIG: "dingtalk:get-config",
    SAVE_CONFIG: "dingtalk:save-config",
    GET_DECRYPTED_SECRET: "dingtalk:get-decrypted-secret",
    TEST_CONNECTION: "dingtalk:test-connection",
    START_BRIDGE: "dingtalk:start-bridge",
    STOP_BRIDGE: "dingtalk:stop-bridge",
    GET_STATUS: "dingtalk:get-status",
    STATUS_CHANGED: "dingtalk:status-changed",
    GET_MULTI_CONFIG: "dingtalk:get-multi-config",
    SAVE_BOT_CONFIG: "dingtalk:save-bot-config",
    REMOVE_BOT: "dingtalk:remove-bot",
    GET_BOT_DECRYPTED_SECRET: "dingtalk:get-bot-decrypted-secret",
    START_BOT: "dingtalk:start-bot",
    STOP_BOT: "dingtalk:stop-bot",
    GET_MULTI_STATUS: "dingtalk:get-multi-status",
    MULTI_STATUS_CHANGED: "dingtalk:multi-status-changed"
  };
  // ../Proma/packages/shared/src/types/wechat.ts
  var WECHAT_IPC_CHANNELS = {
    GET_CONFIG: "wechat:get-config",
    SAVE_CONFIG: "wechat:save-config",
    START_LOGIN: "wechat:start-login",
    LOGOUT: "wechat:logout",
    START_BRIDGE: "wechat:start-bridge",
    STOP_BRIDGE: "wechat:stop-bridge",
    GET_STATUS: "wechat:get-status",
    STATUS_CHANGED: "wechat:status-changed"
  };
  // ../Proma/packages/shared/src/types/automation.ts
  var AUTOMATION_IPC_CHANNELS = {
    LIST: "automation:list",
    CREATE: "automation:create",
    UPDATE: "automation:update",
    DELETE: "automation:delete",
    TOGGLE: "automation:toggle",
    RUN_NOW: "automation:run-now",
    CHANGED: "automation:changed"
  };
  // ../Proma/packages/shared/src/types/planning.ts
  var PLANNING_IPC_CHANNELS = {
    LIST_TODOS: "planning:list-todos",
    CREATE_TODO: "planning:create-todo",
    START_TODO_AGENT: "planning:start-todo-agent",
    TODO_AGENT_SESSION_READY: "planning:todo-agent-session-ready",
    UPDATE_TODO: "planning:update-todo",
    DELETE_TODO: "planning:delete-todo",
    LIST_CALENDAR_EVENTS: "planning:list-calendar-events",
    CREATE_CALENDAR_EVENT: "planning:create-calendar-event",
    UPDATE_CALENDAR_EVENT: "planning:update-calendar-event",
    DELETE_CALENDAR_EVENT: "planning:delete-calendar-event",
    LIST_GROUPS: "planning:list-groups",
    CREATE_GROUP: "planning:create-group",
    UPDATE_GROUP: "planning:update-group",
    DELETE_GROUP: "planning:delete-group",
    LIST_TAGS: "planning:list-tags",
    LIST_ACTIVE_REMINDERS: "planning:list-active-reminders",
    ACKNOWLEDGE_REMINDER: "planning:acknowledge-reminder",
    SNOOZE_REMINDER: "planning:snooze-reminder",
    REMINDER_DUE: "planning:reminder-due",
    OPEN_WINDOW: "planning:open-window",
    CHANGED: "planning:changed",
    AGENT_OPERATION: "planning:agent-operation",
    GET_NATIVE_SYNC_STATUS: "planning:get-native-sync-status",
    REQUEST_NATIVE_SYNC_ACCESS: "planning:request-native-sync-access",
    OPEN_NATIVE_SYNC_PRIVACY_SETTINGS: "planning:open-native-sync-privacy-settings",
    LIST_NATIVE_SYNC_TARGETS: "planning:list-native-sync-targets",
    LIST_NATIVE_CONNECTION_TARGETS: "planning:list-native-connection-targets",
    LIST_NATIVE_CONNECTIONS: "planning:list-native-connections",
    CONNECT_NATIVE_CONNECTION: "planning:connect-native-connection",
    DISCONNECT_NATIVE_CONNECTION: "planning:disconnect-native-connection",
    LIST_NATIVE_SYNC_CONFLICTS: "planning:list-native-sync-conflicts",
    RESOLVE_NATIVE_SYNC_CONFLICT: "planning:resolve-native-sync-conflict",
    LIST_SYNC_PROFILES: "planning:list-sync-profiles",
    SAVE_SYNC_PROFILE: "planning:save-sync-profile"
  };
  // ../Proma/packages/shared/src/types/agent-island.ts
  var AGENT_ISLAND_IPC_CHANNELS = {
    MARK_SESSION_VIEWED: "agent-island:mark-session-viewed"
  };
  // ../Proma/packages/shared/src/utils/context-window.ts
  var ONE_MILLION_CONTEXT_RULES = {
    claude: [
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-fable-5"
    ],
    deepseek: ["deepseek-v4"],
    glm: ["glm-5.2"],
    mimo: ["mimo-v2.5"],
    minimax: ["minimax-m3"],
    kimi: ["k3"],
    qwen: [
      "qwen3.8",
      "qwen3.7",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "qwen3.5-plus",
      "qwen3.5-flash",
      "qwen3-coder-plus"
    ]
  };
  var ONE_MILLION_CONTEXT_DISPLAY_RULES = Object.values(ONE_MILLION_CONTEXT_RULES).flat();
  var EXACT_CONTEXT_RULES = new Set(["k3", "kimi-k3"]);
  var CONTEXT_WINDOW_CONFIG = {
    exclude: ["haiku"],
    rules: [
      ...ONE_MILLION_CONTEXT_DISPLAY_RULES,
      "kimi-k3",
      "mimo-v2-pro"
    ]
  };
  // ../Proma/packages/shared/src/utils/mcp-transport.ts
  var STREAMABLE_HTTP_ALIASES = new Set([
    "streamableHttp",
    "streamable-http",
    "streamable_http"
  ]);
  // ../Proma/apps/electron/src/types/settings.ts
  var SETTINGS_IPC_CHANNELS = {
    GET: "settings:get",
    UPDATE: "settings:update",
    UPDATE_SYNC: "settings:update-sync",
    GET_SYSTEM_THEME: "settings:get-system-theme",
    ON_SYSTEM_THEME_CHANGED: "settings:system-theme-changed",
    ON_THEME_SETTINGS_CHANGED: "settings:theme-settings-changed"
  };
  var SCRATCH_PAD_IPC_CHANNELS = {
    LOAD: "scratch-pad:load",
    SAVE: "scratch-pad:save",
    SAVE_SYNC: "scratch-pad:save-sync",
    EXPORT: "scratch-pad:export",
    CHOOSE_EXPORT_PATH: "scratch-pad:choose-export-path",
    COPY_IMAGE: "scratch-pad:copy-image"
  };
  var APP_ICON_IPC_CHANNELS = {
    SET: "app-icon:set"
  };
  var DOCK_BADGE_IPC_CHANNELS = {
    SET_COUNT: "dock-badge:set-count"
  };
  var QUICK_TASK_IPC_CHANNELS = {
    SUBMIT: "quick-task:submit",
    HIDE: "quick-task:hide",
    FOCUS: "quick-task:focus",
    REREGISTER_GLOBAL_SHORTCUTS: "quick-task:reregister-global-shortcuts",
    GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS: "quick-task:get-global-shortcut-registration-status"
  };
  var VOICE_DICTATION_IPC_CHANNELS = {
    GET_SETTINGS: "voice-dictation:get-settings",
    UPDATE_SETTINGS: "voice-dictation:update-settings",
    TEST_CONNECTION: "voice-dictation:test-connection",
    TOGGLE: "voice-dictation:toggle",
    START: "voice-dictation:start",
    SEND_AUDIO: "voice-dictation:send-audio",
    STOP: "voice-dictation:stop",
    CANCEL: "voice-dictation:cancel",
    PREVIEW: "voice-dictation:preview",
    COMMIT: "voice-dictation:commit",
    HIDE: "voice-dictation:hide",
    RESIZE: "voice-dictation:resize",
    SHOWN: "voice-dictation:shown",
    TOGGLE_STOP: "voice-dictation:toggle-stop",
    TRANSCRIPT: "voice-dictation:transcript",
    STATE: "voice-dictation:state",
    INDICATOR_STATE: "voice-dictation:indicator-state",
    REPORT_VOLUME: "voice-dictation:report-volume",
    REPORT_TRANSCRIPT: "voice-dictation:report-transcript",
    INSERT_TEXT: "voice-dictation:insert-text",
    ACK_INSERT_TEXT: "voice-dictation:ack-insert-text",
    PREVIEW_TEXT: "voice-dictation:preview-text",
    CLEAR_PREVIEW_TEXT: "voice-dictation:clear-preview-text",
    CHECK_MIC_PERMISSION: "voice-dictation:check-mic-permission",
    REQUEST_MIC_PERMISSION: "voice-dictation:request-mic-permission"
  };
  var TRAY_IPC_CHANNELS = {
    OPEN_AGENT_SESSION: "tray:open-agent-session",
    CREATE_SESSION: "tray:create-session"
  };
  var STORAGE_IPC_CHANNELS = {
    GET_STATS: "storage:get-stats",
    CLEANUP: "storage:cleanup",
    CLEANUP_TEMP: "storage:cleanup-temp"
  };
  // ../Proma/apps/electron/src/types/user-profile.ts
  var USER_PROFILE_IPC_CHANNELS = {
    GET: "user-profile:get",
    UPDATE: "user-profile:update"
  };
  // web/preload.ts
  var electronAPI = {
    getRuntimeStatus: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_RUNTIME_STATUS);
    },
    reinitRuntime: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.REINIT_RUNTIME);
    },
    getGitRepoStatus: (dirPath) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_GIT_REPO_STATUS, dirPath);
    },
    getUnstagedChanges: (dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_UNSTAGED_CHANGES, dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId);
    },
    getFileDiff: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_FILE_DIFF, input);
    },
    getUntrackedContent: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_UNTRACKED_CONTENT, input);
    },
    revertFile: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.REVERT_FILE, input);
    },
    getDiffContents: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_DIFF_CONTENTS, input);
    },
    listWorktrees: (repoPath, sessionId) => {
      return ipcRenderer.invoke(IPC_CHANNELS.LIST_WORKTREES, repoPath, sessionId);
    },
    getWorktreeChanges: (worktreePath, baseBranch, sessionId) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_WORKTREE_CHANGES, worktreePath, baseBranch, sessionId);
    },
    openDetachedPreview: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.OPEN_DETACHED_PREVIEW, input);
    },
    getDetachedPreviewData: (previewId) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_DETACHED_PREVIEW_DATA, previewId);
    },
    openExternal: (url) => {
      return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url);
    },
    writeClipboardText: async (text) => {
      await navigator.clipboard.writeText(text);
    },
    windowMinimize: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE);
    },
    windowMaximize: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE);
    },
    windowClose: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE);
    },
    windowIsMaximized: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED);
    },
    onWindowResize: (callback) => {
      const handler = () => callback();
      window.addEventListener("resize", handler);
      return () => window.removeEventListener("resize", handler);
    },
    listChannels: () => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.LIST);
    },
    createChannel: (input) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CREATE, input);
    },
    updateChannel: (id, input) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.UPDATE, id, input);
    },
    deleteChannel: (id) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DELETE, id);
    },
    decryptApiKey: (channelId) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, channelId);
    },
    testChannel: (channelId) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST, channelId);
    },
    testChannelDirect: (input) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST_DIRECT, input);
    },
    fetchModels: (input) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input);
    },
    getChannelPlanQuota: (channelId) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA, channelId);
    },
    codexOAuthLogin: (method) => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_LOGIN, method);
    },
    codexOAuthCancel: () => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_CANCEL);
    },
    onCodexOAuthDeviceCode: (callback) => {
      const listener = (_event, deviceCode) => callback(deviceCode);
      ipcRenderer.on(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_DEVICE_CODE, listener);
      return () => ipcRenderer.removeListener(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_DEVICE_CODE, listener);
    },
    xaiOAuthLogin: () => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.XAI_OAUTH_LOGIN);
    },
    xaiOAuthCancel: () => {
      return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.XAI_OAUTH_CANCEL);
    },
    onXaiOAuthDeviceCode: (callback) => {
      const listener = (_event, deviceCode) => callback(deviceCode);
      ipcRenderer.on(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, listener);
      return () => ipcRenderer.removeListener(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, listener);
    },
    listConversations: () => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS);
    },
    createConversation: (title, modelId, channelId) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, title, modelId, channelId);
    },
    getConversationMessages: (id) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_MESSAGES, id);
    },
    getRecentMessages: (id, limit) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES, id, limit);
    },
    updateConversationTitle: (id, title) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.UPDATE_TITLE, id, title);
    },
    updateConversationModel: (id, modelId, channelId) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.UPDATE_MODEL, id, modelId, channelId);
    },
    deleteConversation: (id) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, id);
    },
    togglePinConversation: (id) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.TOGGLE_PIN, id);
    },
    toggleArchiveConversation: (id) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.TOGGLE_ARCHIVE, id);
    },
    searchConversationMessages: (query) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.SEARCH_MESSAGES, query);
    },
    getTutorialContent: () => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_TUTORIAL_CONTENT);
    },
    createWelcomeConversation: () => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.CREATE_WELCOME_CONVERSATION);
    },
    sendMessage: (input) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.SEND_MESSAGE, input);
    },
    stopGeneration: (conversationId) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.STOP_GENERATION, conversationId);
    },
    deleteMessage: (conversationId, messageId) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.DELETE_MESSAGE, conversationId, messageId);
    },
    truncateMessagesFrom: (conversationId, messageId, preserveFirstMessageAttachments = false) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM, conversationId, messageId, preserveFirstMessageAttachments);
    },
    updateContextDividers: (conversationId, dividers) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS, conversationId, dividers);
    },
    generateTitle: (input) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.GENERATE_TITLE, input);
    },
    saveAttachment: (input) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.SAVE_ATTACHMENT, input);
    },
    readAttachment: (localPath) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.READ_ATTACHMENT, localPath);
    },
    saveImageAs: (localPath, defaultFilename) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.SAVE_IMAGE_AS, localPath, defaultFilename);
    },
    saveResourceFileAs: (resourceRelativePath, defaultFilename) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS, resourceRelativePath, defaultFilename);
    },
    deleteAttachment: (localPath) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.DELETE_ATTACHMENT, localPath);
    },
    openFileDialog: () => {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", async () => {
          input.remove();
          const picked = input.files ? Array.from(input.files) : [];
          if (picked.length === 0) {
            resolve({ files: [], directories: [] });
            return;
          }
          const files = [];
          const largeFiles = [];
          const skippedFiles = [];
          const MAX_SIZE = 100 * 1024 * 1024;
          for (const f of picked) {
            const mediaType = f.type || "application/octet-stream";
            try {
              if (f.size > MAX_SIZE) {
                largeFiles.push({ filename: f.name, mediaType, size: f.size, path: "" });
                continue;
              }
              const data = await new Promise((res, rej) => {
                const reader = new FileReader;
                reader.onload = () => res(String(reader.result).split(",")[1] || "");
                reader.onerror = () => rej(reader.error || new Error("read failed"));
                reader.readAsDataURL(f);
              });
              files.push({ filename: f.name, mediaType, data, size: f.size });
            } catch (e) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: "", reason: "unreadable", message: String(e) });
            }
          }
          const result = { files, directories: [] };
          if (largeFiles.length > 0)
            result.largeFiles = largeFiles;
          if (skippedFiles.length > 0)
            result.skippedFiles = skippedFiles;
          resolve(result);
        });
        input.click();
      });
    },
    extractAttachmentText: (localPath) => {
      return ipcRenderer.invoke(CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT, localPath);
    },
    getUserProfile: () => {
      return ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.GET);
    },
    updateUserProfile: (updates) => {
      return ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.UPDATE, updates);
    },
    getSettings: () => {
      return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET);
    },
    updateSettings: (updates) => {
      return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, updates);
    },
    updateSettingsSync: (updates) => {
      return ipcRenderer.sendSync(SETTINGS_IPC_CHANNELS.UPDATE_SYNC, updates);
    },
    getSystemTheme: () => {
      return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME);
    },
    onSystemThemeChanged: (callback) => {
      const listener = (_, isDark) => callback(isDark);
      ipcRenderer.on(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, listener);
      };
    },
    onThemeSettingsChanged: (callback) => {
      const listener = (_, payload) => callback(payload);
      ipcRenderer.on(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, listener);
      };
    },
    loadScratchPad: () => {
      return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.LOAD);
    },
    saveScratchPad: (content) => {
      return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.SAVE, content);
    },
    saveScratchPadSync: (content) => {
      return ipcRenderer.sendSync(SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC, content);
    },
    exportScratchPad: (markdown, dirPath, filename) => {
      return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.EXPORT, markdown, dirPath, filename);
    },
    chooseExportPath: (defaultName) => {
      return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.CHOOSE_EXPORT_PATH, defaultName);
    },
    copyImageToClipboard: (dataUrl) => {
      return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.COPY_IMAGE, dataUrl);
    },
    setAppIcon: (variantId) => {
      return ipcRenderer.invoke(APP_ICON_IPC_CHANNELS.SET, variantId);
    },
    setDockBadgeCount: (count) => {
      return ipcRenderer.invoke(DOCK_BADGE_IPC_CHANNELS.SET_COUNT, count);
    },
    checkEnvironment: () => {
      return ipcRenderer.invoke(ENVIRONMENT_IPC_CHANNELS.CHECK);
    },
    fetchInstallerManifest: () => {
      return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.MANIFEST);
    },
    downloadInstaller: (req) => {
      return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.DOWNLOAD, req);
    },
    cancelInstallerDownload: (key) => {
      return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.CANCEL, key);
    },
    launchInstaller: (filePath) => {
      return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.LAUNCH, filePath);
    },
    onInstallerProgress: (callback) => {
      const listener = (_, payload) => callback(payload);
      ipcRenderer.on(INSTALLER_IPC_CHANNELS.PROGRESS, listener);
      return () => ipcRenderer.off(INSTALLER_IPC_CHANNELS.PROGRESS, listener);
    },
    getProxySettings: () => {
      return ipcRenderer.invoke(PROXY_IPC_CHANNELS.GET_SETTINGS);
    },
    updateProxySettings: (config2) => {
      return ipcRenderer.invoke(PROXY_IPC_CHANNELS.UPDATE_SETTINGS, config2);
    },
    detectSystemProxy: () => {
      return ipcRenderer.invoke(PROXY_IPC_CHANNELS.DETECT_SYSTEM);
    },
    onStreamChunk: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(CHAT_IPC_CHANNELS.STREAM_CHUNK, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_IPC_CHANNELS.STREAM_CHUNK, listener);
      };
    },
    onStreamReasoning: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(CHAT_IPC_CHANNELS.STREAM_REASONING, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_IPC_CHANNELS.STREAM_REASONING, listener);
      };
    },
    onStreamComplete: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(CHAT_IPC_CHANNELS.STREAM_COMPLETE, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_IPC_CHANNELS.STREAM_COMPLETE, listener);
      };
    },
    onStreamError: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(CHAT_IPC_CHANNELS.STREAM_ERROR, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_IPC_CHANNELS.STREAM_ERROR, listener);
      };
    },
    onStreamToolActivity: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, listener);
      };
    },
    listAgentSessions: () => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS);
    },
    createAgentSession: (title, channelId, workspaceId, modelId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SESSION, title, channelId, workspaceId, modelId);
    },
    getAgentSessionSDKMessages: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, id);
    },
    updateAgentSessionTitle: (id, title) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_TITLE, id, title);
    },
    updateSessionCodexFastMode: (sessionId, enabled) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE, sessionId, enabled);
    },
    getPiReasoningCapability: (channelId, modelId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY, channelId, modelId);
    },
    updateSessionReasoningLevel: (sessionId, thinkingLevel) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_REASONING_LEVEL, sessionId, thinkingLevel);
    },
    updateAgentSessionModel: (id, channelId, modelId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL, id, channelId, modelId);
    },
    deleteAgentSession: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, id);
    },
    migrateChatToAgent: (conversationId, agentSessionId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT, conversationId, agentSessionId);
    },
    togglePinAgentSession: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_PIN, id);
    },
    toggleStarAgentSession: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_STAR, id);
    },
    clearAgentCompletionState: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE, id);
    },
    toggleArchiveAgentSession: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, id);
    },
    searchAgentSessionMessages: (query) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_MESSAGES, query);
    },
    searchAgentSessionReferences: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_SESSION_REFERENCES, input);
    },
    moveAgentSessionToWorkspace: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_SESSION_TO_WORKSPACE, input);
    },
    forkAgentSession: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.FORK_SESSION, input);
    },
    rewindSession: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REWIND_SESSION, input);
    },
    generateAgentTitle: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GENERATE_TITLE, input);
    },
    sendAgentMessage: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND_MESSAGE, input);
    },
    stopAgent: (sessionId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, sessionId);
    },
    queueAgentMessage: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.QUEUE_MESSAGE, input);
    },
    getTaskOutput: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_TASK_OUTPUT, input);
    },
    stopTask: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_TASK, input);
    },
    listAgentWorkspaces: () => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACES);
    },
    createAgentWorkspace: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_WORKSPACE, input);
    },
    createAgentProject: (input, channelId, modelId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_PROJECT, input, channelId, modelId);
    },
    updateAgentWorkspace: (id, updates) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, id, updates);
    },
    relinkAgentWorkspaceProjectRoot: (id, projectRootPath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RELINK_WORKSPACE_PROJECT_ROOT, id, projectRootPath);
    },
    restoreAgentWorkspaceProjectRoot: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESTORE_WORKSPACE_PROJECT_ROOT, id);
    },
    deleteAgentWorkspace: (id) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, id);
    },
    reorderAgentWorkspaces: (orderedIds) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REORDER_WORKSPACES, orderedIds);
    },
    getWorkspaceCapabilities: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_CAPABILITIES, workspaceSlug);
    },
    getWorkspaceMcpConfig: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, workspaceSlug);
    },
    saveWorkspaceMcpConfig: (workspaceSlug, config2) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, workspaceSlug, config2);
    },
    testMcpServer: (name, entry) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TEST_MCP_SERVER, name, entry);
    },
    setBuiltinMcpEnabled: (workspaceSlug, id, enabled) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SET_BUILTIN_MCP_ENABLED, workspaceSlug, id, enabled);
    },
    getWorkspaceSkills: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SKILLS, workspaceSlug);
    },
    getWorkspaceSkillsDir: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SKILLS_DIR, workspaceSlug);
    },
    deleteWorkspaceSkill: (workspaceSlug, skillSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SKILL, workspaceSlug, skillSlug);
    },
    toggleWorkspaceSkill: (workspaceSlug, skillSlug, enabled) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_SKILL, workspaceSlug, skillSlug, enabled);
    },
    getOtherWorkspaceSkills: (currentSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_OTHER_WORKSPACE_SKILLS, currentSlug);
    },
    getDefaultSkillSlugs: () => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_DEFAULT_SKILL_SLUGS);
    },
    importSkillFromWorkspace: (targetSlug, sourceSlug, skillSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.IMPORT_SKILL_FROM_WORKSPACE, targetSlug, sourceSlug, skillSlug);
    },
    batchImportSkillsFromWorkspaces: (targetSlug, selections) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.BATCH_IMPORT_SKILLS_FROM_WORKSPACES, targetSlug, selections);
    },
    updateSkillFromSource: (targetSlug, skillSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SKILL_FROM_SOURCE, targetSlug, skillSlug);
    },
    readSkillContent: (workspaceSlug, skillSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_SKILL_CONTENT, workspaceSlug, skillSlug);
    },
    writeSkillContent: (workspaceSlug, skillSlug, content) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_SKILL_CONTENT, workspaceSlug, skillSlug, content);
    },
    listSkillFiles: (workspaceSlug, skillSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SKILL_FILES, workspaceSlug, skillSlug);
    },
    readSkillFile: (workspaceSlug, skillSlug, relativePath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_SKILL_FILE, workspaceSlug, skillSlug, relativePath);
    },
    writeSkillFile: (workspaceSlug, skillSlug, relativePath, content) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_SKILL_FILE, workspaceSlug, skillSlug, relativePath, content);
    },
    createSkillEntry: (workspaceSlug, skillSlug, relativePath, type) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SKILL_ENTRY, workspaceSlug, skillSlug, relativePath, type);
    },
    deleteSkillEntry: (workspaceSlug, skillSlug, relativePath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SKILL_ENTRY, workspaceSlug, skillSlug, relativePath);
    },
    renameSkillEntry: (workspaceSlug, skillSlug, fromRelative, toRelative) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_SKILL_ENTRY, workspaceSlug, skillSlug, fromRelative, toRelative);
    },
    getWorkspaceMemorySummary: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_MEMORY_SUMMARY, workspaceSlug);
    },
    readWorkspaceAgentsMd: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_WORKSPACE_AGENTS_MD, workspaceSlug);
    },
    writeWorkspaceAgentsMd: (workspaceSlug, content) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_WORKSPACE_AGENTS_MD, workspaceSlug, content);
    },
    listWorkspaceAutoMemoryFiles: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACE_AUTO_MEMORY_FILES, workspaceSlug);
    },
    readWorkspaceAutoMemoryFile: (workspaceSlug, relativePath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_WORKSPACE_AUTO_MEMORY_FILE, workspaceSlug, relativePath);
    },
    writeWorkspaceAutoMemoryFile: (workspaceSlug, relativePath, content) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_WORKSPACE_AUTO_MEMORY_FILE, workspaceSlug, relativePath, content);
    },
    openWorkspaceMemoryWindow: (workspaceSlug, relativePath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_MEMORY_WINDOW, workspaceSlug, relativePath);
    },
    onWorkspaceMemoryWindowOpenFile: (callback) => {
      const listener = (_, relativePath) => callback(relativePath);
      ipcRenderer.on(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_OPEN_FILE, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_OPEN_FILE, listener);
      };
    },
    onWorkspaceMemoryWindowCloseRequested: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_CLOSE_REQUESTED, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_CLOSE_REQUESTED, listener);
      };
    },
    confirmWorkspaceMemoryWindowClose: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CONFIRM_WORKSPACE_MEMORY_WINDOW_CLOSE, workspaceSlug);
    },
    markWorkspaceMemoryWindowReady: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_READY, workspaceSlug);
    },
    subscribeWorkspaceMemoryChanges: (workspaceSlug, callback) => {
      const listener = (_, payload) => {
        if (payload.workspaceSlug === workspaceSlug)
          callback(payload.change);
      };
      ipcRenderer.on(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_FILE_CHANGED, listener);
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.START_WORKSPACE_MEMORY_WATCH, workspaceSlug);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_FILE_CHANGED, listener);
        ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_WORKSPACE_MEMORY_WATCH, workspaceSlug);
      };
    },
    approveWorkspaceProjectKnowledgeMaintenance: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.APPROVE_WORKSPACE_PROJECT_KNOWLEDGE_MAINTENANCE, workspaceSlug);
    },
    onAgentStreamEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_EVENT, listener);
      };
    },
    onAgentStreamComplete: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_COMPLETE, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_COMPLETE, listener);
      };
    },
    onAgentStreamError: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_ERROR, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_ERROR, listener);
      };
    },
    onAgentTitleUpdated: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(AGENT_IPC_CHANNELS.TITLE_UPDATED, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.TITLE_UPDATED, listener);
      };
    },
    respondPermission: (response) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, response);
    },
    updateSessionPermissionMode: (sessionId, mode) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE, sessionId, mode);
    },
    getChatTools: () => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS);
    },
    getChatToolCredentials: (toolId) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS, toolId);
    },
    updateChatToolState: (toolId, state) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE, toolId, state);
    },
    updateChatToolCredentials: (toolId, credentials) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS, toolId, credentials);
    },
    createCustomChatTool: (meta) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL, meta);
    },
    deleteCustomChatTool: (toolId) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL, toolId);
    },
    onCustomToolChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, listener);
      };
    },
    testChatTool: (toolId) => {
      return ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.TEST_TOOL, toolId);
    },
    respondAskUser: (response) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, response);
    },
    respondExitPlanMode: (response) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND, response);
    },
    getPendingRequests: () => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PENDING_REQUESTS);
    },
    onCapabilitiesChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, listener);
      };
    },
    onWorkspaceFilesChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener);
      };
    },
    saveFilesToAgentSession: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION, input);
    },
    saveFilesToWorkspaceFiles: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE, input);
    },
    getWorkspaceFilesPath: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH, workspaceSlug);
    },
    openFolderDialog: () => {
      console.warn("[Web] openFolderDialog 暂不支持：浏览器安全限制无法获取文件夹磁盘路径");
      try {
        const div = document.createElement("div");
        div.textContent = "Web 版暂不支持选择文件夹（浏览器安全限制无法获取磁盘路径），可改用添加文件或在工作区放置目录";
        div.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#1f2937;color:#fbbf24;padding:10px 16px;border-radius:10px;border:1px solid #4b5563;font:13px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.35);max-width:80%";
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 4000);
      } catch {}
      return Promise.resolve(null);
    },
    openFileOrFolderDialog: () => {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", async () => {
          input.remove();
          const picked = input.files ? Array.from(input.files) : [];
          if (picked.length === 0) {
            resolve({ files: [], directories: [] });
            return;
          }
          const files = [];
          const largeFiles = [];
          const skippedFiles = [];
          const MAX_SIZE = 100 * 1024 * 1024;
          for (const f of picked) {
            const mediaType = f.type || "application/octet-stream";
            try {
              if (f.size > MAX_SIZE) {
                largeFiles.push({ filename: f.name, mediaType, size: f.size, path: "" });
                continue;
              }
              const data = await new Promise((res, rej) => {
                const reader = new FileReader;
                reader.onload = () => res(String(reader.result).split(",")[1] || "");
                reader.onerror = () => rej(reader.error || new Error("read failed"));
                reader.readAsDataURL(f);
              });
              files.push({ filename: f.name, mediaType, data, size: f.size });
            } catch (e) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: "", reason: "unreadable", message: String(e) });
            }
          }
          const result = { files, directories: [] };
          if (largeFiles.length > 0)
            result.largeFiles = largeFiles;
          if (skippedFiles.length > 0)
            result.skippedFiles = skippedFiles;
          resolve(result);
        });
        input.click();
      });
    },
    attachDirectory: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_DIRECTORY, input);
    },
    detachDirectory: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_DIRECTORY, input);
    },
    attachFile: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_FILE, input);
    },
    detachFile: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_FILE, input);
    },
    attachWorkspaceDirectory: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY, input);
    },
    detachWorkspaceDirectory: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY, input);
    },
    attachWorkspaceFile: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_FILE, input);
    },
    detachWorkspaceFile: (input) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_WORKSPACE_FILE, input);
    },
    getWorkspaceDirectories: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_DIRECTORIES, workspaceSlug);
    },
    getWorkspaceAttachedFiles: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_ATTACHED_FILES, workspaceSlug);
    },
    getWorktreeRepos: (workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKTREE_REPOS, workspaceSlug);
    },
    addWorktreeRepo: (workspaceSlug, repo) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ADD_WORKTREE_REPO, workspaceSlug, repo);
    },
    removeWorktreeRepo: (workspaceSlug, repoPath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REMOVE_WORKTREE_REPO, workspaceSlug, repoPath);
    },
    getAgentSessionPath: (workspaceId, sessionId) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SESSION_PATH, workspaceId, sessionId);
    },
    listDirectory: (dirPath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_DIRECTORY, dirPath, access);
    },
    deleteFile: (filePath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_FILE, filePath, access);
    },
    openFile: (filePath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE, filePath, access);
    },
    writeClipboardPreview: (filename, content) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_CLIPBOARD_PREVIEW, filename, content);
    },
    systemOpenFile: (filePath, appName, access) => {
      return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_FILE, filePath, appName, access);
    },
    scanEditors: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.SCAN_EDITORS);
    },
    getDefaultAppForFile: (filePath, access) => {
      return ipcRenderer.invoke(IPC_CHANNELS.GET_DEFAULT_APP_FOR_FILE, filePath, access);
    },
    showInFolder: (filePath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SHOW_IN_FOLDER, filePath, access);
    },
    openFolderInTerminal: (folderPath) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FOLDER_IN_TERMINAL, folderPath);
    },
    showItemInFolder: (filePath, candidateBasePaths) => {
      return ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, filePath, candidateBasePaths);
    },
    resolveAndReadFile: (filePath, access) => {
      return ipcRenderer.invoke("file:resolve-and-read", filePath, access);
    },
    writeTextFile: (filePath, content, access) => {
      return ipcRenderer.invoke("file:write-text", filePath, content, access);
    },
    resolveFilePath: (filePath, access) => {
      return ipcRenderer.invoke("file:resolve-path", filePath, access);
    },
    preparePdfPreview: (filePath, access) => {
      return ipcRenderer.invoke("file:prepare-pdf-preview", filePath, access);
    },
    readBinaryBase64: (filePath, access, maxSize) => {
      return ipcRenderer.invoke("file:read-binary-base64", filePath, access, maxSize);
    },
    docxToHtml: (filePath, access) => {
      return ipcRenderer.invoke("file:docx-to-html", filePath, access);
    },
    officeToHtml: (filePath, access) => {
      return ipcRenderer.invoke("file:office-to-html", filePath, access);
    },
    screenshotCapture: (input) => {
      return ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, input);
    },
    renameFile: (filePath, newName, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_FILE, filePath, newName, access);
    },
    moveFile: (filePath, targetDir, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_FILE, filePath, targetDir, access);
    },
    listAttachedDirectory: (dirPath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY, dirPath, access);
    },
    readAttachedFile: (filePath, sessionId, workspaceSlug) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_ATTACHED_FILE, filePath, sessionId, workspaceSlug);
    },
    showAttachedInFolder: (filePath, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER, filePath, access);
    },
    renameAttachedFile: (filePath, newName, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE, filePath, newName, access);
    },
    moveAttachedFile: (filePath, targetDir, access) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE, filePath, targetDir, access);
    },
    checkPathsType: (paths) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CHECK_PATHS_TYPE, paths);
    },
    getPathForFile: (file) => {
      return webUtils.getPathForFile(file);
    },
    searchWorkspaceFiles: (rootPath, query, limit = 20, additionalPaths, sessionPaths) => {
      return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES, rootPath, query, limit, additionalPaths, sessionPaths);
    },
    getSystemPromptConfig: () => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG);
    },
    createSystemPrompt: (input) => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.CREATE, input);
    },
    updateSystemPrompt: (id, input) => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE, id, input);
    },
    deleteSystemPrompt: (id) => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, id);
    },
    updateAppendSetting: (enabled) => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING, enabled);
    },
    setDefaultPrompt: (id) => {
      return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT, id);
    },
    updater: {
      checkForUpdates: () => ipcRenderer.invoke("updater:check"),
      getStatus: () => ipcRenderer.invoke("updater:get-status"),
      onStatusChanged: (callback) => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on("updater:status-changed", listener);
        return () => {
          ipcRenderer.removeListener("updater:status-changed", listener);
        };
      },
      installWhenIdle: () => ipcRenderer.invoke("updater:install-when-idle"),
      cancelIdleInstall: () => ipcRenderer.invoke("updater:cancel-idle-install")
    },
    getLatestRelease: () => {
      return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE);
    },
    listReleases: (options) => {
      return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES, options);
    },
    getReleaseByTag: (tag) => {
      return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG, tag);
    },
    getFeishuConfig: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_CONFIG);
    },
    getDecryptedFeishuSecret: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET);
    },
    saveFeishuConfig: (input) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.SAVE_CONFIG, input);
    },
    testFeishuConnection: (appId, appSecret) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.TEST_CONNECTION, appId, appSecret);
    },
    startFeishuBridge: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.START_BRIDGE);
    },
    stopFeishuBridge: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.STOP_BRIDGE);
    },
    getFeishuStatus: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_STATUS);
    },
    listFeishuBindings: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.LIST_BINDINGS);
    },
    updateFeishuBinding: (input) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.UPDATE_BINDING, input);
    },
    removeFeishuBinding: (chatId) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REMOVE_BINDING, chatId);
    },
    reportFeishuPresence: (report) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REPORT_PRESENCE, report);
    },
    onFeishuStatusChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(FEISHU_IPC_CHANNELS.STATUS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.STATUS_CHANGED, listener);
      };
    },
    getFeishuMultiConfig: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_MULTI_CONFIG);
    },
    saveFeishuBotConfig: (input) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG, input);
    },
    getDecryptedFeishuBotSecret: (botId) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET, botId);
    },
    removeFeishuBot: (botId) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REMOVE_BOT, botId);
    },
    startFeishuBot: (botId) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.START_BOT, botId);
    },
    stopFeishuBot: (botId) => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.STOP_BOT, botId);
    },
    getFeishuMultiStatus: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_MULTI_STATUS);
    },
    registerFeishuApp: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REGISTER_APP_START);
    },
    cancelFeishuRegistration: () => {
      return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REGISTER_APP_CANCEL);
    },
    onFeishuRegisterQrcode: (callback) => {
      const listener = (_, payload) => callback(payload);
      ipcRenderer.on(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, listener);
      return () => {
        ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, listener);
      };
    },
    onFeishuRegisterStatus: (callback) => {
      const listener = (_, payload) => callback(payload);
      ipcRenderer.on(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, listener);
      };
    },
    getWeChatConfig: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.GET_CONFIG);
    },
    startWeChatLogin: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.START_LOGIN);
    },
    logoutWeChat: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.LOGOUT);
    },
    startWeChatBridge: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.START_BRIDGE);
    },
    stopWeChatBridge: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.STOP_BRIDGE);
    },
    getWeChatStatus: () => {
      return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.GET_STATUS);
    },
    onWeChatStatusChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(WECHAT_IPC_CHANNELS.STATUS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(WECHAT_IPC_CHANNELS.STATUS_CHANGED, listener);
      };
    },
    getDingTalkConfig: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_CONFIG);
    },
    getDecryptedDingTalkSecret: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET);
    },
    saveDingTalkConfig: (input) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.SAVE_CONFIG, input);
    },
    testDingTalkConnection: (clientId, clientSecret) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.TEST_CONNECTION, clientId, clientSecret);
    },
    startDingTalkBridge: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.START_BRIDGE);
    },
    stopDingTalkBridge: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.STOP_BRIDGE);
    },
    getDingTalkStatus: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_STATUS);
    },
    onDingTalkStatusChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(DINGTALK_IPC_CHANNELS.STATUS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(DINGTALK_IPC_CHANNELS.STATUS_CHANGED, listener);
      };
    },
    getDingTalkMultiConfig: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_MULTI_CONFIG);
    },
    saveDingTalkBotConfig: (input) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG, input);
    },
    getDecryptedDingTalkBotSecret: (botId) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET, botId);
    },
    removeDingTalkBot: (botId) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.REMOVE_BOT, botId);
    },
    startDingTalkBot: (botId) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.START_BOT, botId);
    },
    stopDingTalkBot: (botId) => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.STOP_BOT, botId);
    },
    getDingTalkMultiStatus: () => {
      return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_MULTI_STATUS);
    },
    onMenuCloseTab: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("menu:close-tab", listener);
      return () => {
        ipcRenderer.removeListener("menu:close-tab", listener);
      };
    },
    submitQuickTask: (input) => {
      return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.SUBMIT, input);
    },
    hideQuickTask: () => {
      return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.HIDE);
    },
    reregisterGlobalShortcuts: () => {
      return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.REREGISTER_GLOBAL_SHORTCUTS);
    },
    getGlobalShortcutRegistrationStatus: () => {
      return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS);
    },
    onQuickTaskFocus: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(QUICK_TASK_IPC_CHANNELS.FOCUS, listener);
      return () => {
        ipcRenderer.removeListener(QUICK_TASK_IPC_CHANNELS.FOCUS, listener);
      };
    },
    onQuickTaskOpenSession: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on("quick-task:open-session", listener);
      return () => {
        ipcRenderer.removeListener("quick-task:open-session", listener);
      };
    },
    getVoiceDictationSettings: () => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS);
    },
    updateVoiceDictationSettings: (updates) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.UPDATE_SETTINGS, updates);
    },
    testVoiceDictationConnection: (updates) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.TEST_CONNECTION, updates);
    },
    toggleVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.TOGGLE, input);
    },
    startVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.START, input);
    },
    sendVoiceDictationAudio: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.SEND_AUDIO, input);
    },
    reportVoiceDictationVolume: (volume) => {
      ipcRenderer.send(VOICE_DICTATION_IPC_CHANNELS.REPORT_VOLUME, volume);
    },
    reportVoiceDictationTranscript: (text) => {
      ipcRenderer.send(VOICE_DICTATION_IPC_CHANNELS.REPORT_TRANSCRIPT, text);
    },
    stopVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.STOP, input);
    },
    cancelVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.CANCEL, input);
    },
    commitVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.COMMIT, input);
    },
    previewVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.PREVIEW, input);
    },
    hideVoiceDictation: () => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.HIDE);
    },
    resizeVoiceDictation: (input) => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.RESIZE, input);
    },
    onVoiceDictationShown: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.SHOWN, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.SHOWN, listener);
      };
    },
    onVoiceDictationToggleStop: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.TOGGLE_STOP, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.TOGGLE_STOP, listener);
      };
    },
    onVoiceDictationTranscript: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.TRANSCRIPT, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.TRANSCRIPT, listener);
      };
    },
    onVoiceDictationState: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.STATE, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.STATE, listener);
      };
    },
    onVoiceDictationIndicatorState: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.INDICATOR_STATE, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.INDICATOR_STATE, listener);
      };
    },
    onVoiceDictationInsertText: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.INSERT_TEXT, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.INSERT_TEXT, listener);
      };
    },
    acknowledgeVoiceDictationTextDelivery: (input) => {
      ipcRenderer.send(VOICE_DICTATION_IPC_CHANNELS.ACK_INSERT_TEXT, input);
    },
    onVoiceDictationPreviewText: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.PREVIEW_TEXT, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.PREVIEW_TEXT, listener);
      };
    },
    onVoiceDictationClearPreviewText: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.CLEAR_PREVIEW_TEXT, listener);
      return () => {
        ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.CLEAR_PREVIEW_TEXT, listener);
      };
    },
    checkMicrophonePermission: () => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.CHECK_MIC_PERMISSION);
    },
    requestMicrophonePermission: () => {
      return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.REQUEST_MIC_PERMISSION);
    },
    onTrayOpenAgentSession: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, listener);
      return () => {
        ipcRenderer.removeListener(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, listener);
      };
    },
    onTrayCreateSession: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on(TRAY_IPC_CHANNELS.CREATE_SESSION, listener);
      return () => {
        ipcRenderer.removeListener(TRAY_IPC_CHANNELS.CREATE_SESSION, listener);
      };
    },
    migrationGetExportPreview: (workspaceId) => {
      return ipcRenderer.invoke("migration:getExportPreview", workspaceId);
    },
    migrationGetShareExportPreview: () => {
      return ipcRenderer.invoke("migration:getShareExportPreview");
    },
    migrationExport: (options) => {
      return ipcRenderer.invoke("migration:export", options);
    },
    migrationExportV2: (options) => {
      return ipcRenderer.invoke("migration:exportV2", options);
    },
    migrationParseImportFile: (filePath) => {
      return ipcRenderer.invoke("migration:parseImportFile", filePath);
    },
    migrationConfirmImport: (options) => {
      return ipcRenderer.invoke("migration:confirmImport", options);
    },
    migrationOpenFileDialog: () => {
      return ipcRenderer.invoke("migration:openFileDialog");
    },
    migrationSaveFileDialog: (mode) => {
      return ipcRenderer.invoke("migration:saveFileDialog", mode);
    },
    onMigrationOpenImportFile: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on("migration:open-import-file", listener);
      return () => {
        ipcRenderer.removeListener("migration:open-import-file", listener);
      };
    },
    getStorageStats: () => {
      return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.GET_STATS);
    },
    cleanupStorage: (options) => {
      return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.CLEANUP, options);
    },
    cleanupTempStorage: () => {
      return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.CLEANUP_TEMP);
    },
    migrationCancelImport: (tempDir) => {
      return ipcRenderer.invoke("migration:cancelImport", tempDir);
    },
    listAutomations: () => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.LIST),
    createAutomation: (input) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.CREATE, input),
    updateAutomation: (input) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.UPDATE, input),
    deleteAutomation: (id) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.DELETE, id),
    toggleAutomation: (id, active) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.TOGGLE, id, active),
    runAutomationNow: (id) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.RUN_NOW, id),
    onAutomationChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(AUTOMATION_IPC_CHANNELS.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(AUTOMATION_IPC_CHANNELS.CHANGED, listener);
      };
    },
    openPlanningWindow: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.OPEN_WINDOW),
    listTodos: (query) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_TODOS, query),
    createTodo: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_TODO, input),
    startTodoAgent: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.START_TODO_AGENT, input),
    onTodoAgentSessionReady: (callback) => {
      const listener = (_, activation) => callback(activation);
      ipcRenderer.on(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, listener);
      return () => {
        ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, listener);
      };
    },
    updateTodo: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_TODO, input),
    deleteTodo: (id) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_TODO, id),
    listCalendarEvents: (query) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS, query),
    createCalendarEvent: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT, input),
    updateCalendarEvent: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT, input),
    deleteCalendarEvent: (id) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT, id),
    listPlanningGroups: (scope) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_GROUPS, scope),
    createPlanningGroup: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_GROUP, input),
    updatePlanningGroup: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_GROUP, input),
    deletePlanningGroup: (scope, id) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_GROUP, scope, id),
    listPlanningTags: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_TAGS),
    listActivePlanningReminders: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS),
    acknowledgePlanningReminder: (id) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, id),
    snoozePlanningReminder: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.SNOOZE_REMINDER, input),
    onPlanningRemindersDue: (callback) => {
      const listener = (_, reminders) => callback(reminders);
      ipcRenderer.on(PLANNING_IPC_CHANNELS.REMINDER_DUE, listener);
      return () => {
        ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.REMINDER_DUE, listener);
      };
    },
    onPlanningChanged: (callback) => {
      const listener = (_, change) => callback(change);
      ipcRenderer.on(PLANNING_IPC_CHANNELS.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.CHANGED, listener);
      };
    },
    onPlanningAgentOperation: (callback) => {
      const listener = (_, operation) => callback(operation);
      ipcRenderer.on(PLANNING_IPC_CHANNELS.AGENT_OPERATION, listener);
      return () => {
        ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.AGENT_OPERATION, listener);
      };
    },
    getPlanningNativeSyncStatus: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.GET_NATIVE_SYNC_STATUS),
    requestPlanningNativeSyncAccess: (entity) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.REQUEST_NATIVE_SYNC_ACCESS, entity),
    openPlanningNativeSyncPrivacySettings: (entity) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.OPEN_NATIVE_SYNC_PRIVACY_SETTINGS, entity),
    listPlanningNativeSyncTargets: (entity) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_NATIVE_SYNC_TARGETS, entity),
    listPlanningNativeConnectionTargets: (entity) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_NATIVE_CONNECTION_TARGETS, entity),
    listPlanningNativeConnections: (entity) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_NATIVE_CONNECTIONS, entity),
    connectPlanningNativeConnection: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CONNECT_NATIVE_CONNECTION, input),
    disconnectPlanningNativeConnection: (id) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DISCONNECT_NATIVE_CONNECTION, id),
    listPlanningNativeSyncConflicts: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_NATIVE_SYNC_CONFLICTS),
    resolvePlanningNativeSyncConflict: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.RESOLVE_NATIVE_SYNC_CONFLICT, input),
    listPlanningSyncProfiles: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_SYNC_PROFILES),
    savePlanningSyncProfile: (input) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.SAVE_SYNC_PROFILE, input),
    agentIsland: {
      markSessionViewed: (sessionId) => ipcRenderer.invoke(AGENT_ISLAND_IPC_CHANNELS.MARK_SESSION_VIEWED, sessionId)
    }
  };
  contextBridge.exposeInMainWorld("electronAPI", electronAPI);
})();
